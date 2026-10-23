#!/usr/bin/env node
// Opens a staging page as a role and saves a screenshot or a short video.
// Usage: node bin/shot.mjs --as <anon|user|academy|admin> --url <path> --out <file>
//          [--mobile] [--full] [--selector <css>] [--video <seconds>] [--force <experiment id>.<variant id>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROLES, USER_AGENT, absoluteUrl, grantConsent, installGuard, launchBrowser, slowScroll, statePath } from './browser.mjs'

function parseArgs(argv) {
  const args = { mobile: false, full: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--mobile') args.mobile = true
    else if (arg === '--full') args.full = true
    else if (['--as', '--url', '--out', '--selector', '--video', '--force'].includes(arg)) args[arg.slice(2)] = argv[++i]
    else throw new Error(`Unknown argument ${arg}`)
  }
  if (!args.as || !args.url || !args.out) throw new Error('--as, --url and --out are required')
  if (args.as !== 'anon' && !ROLES.includes(args.as)) throw new Error('--as must be anon, user, academy or admin')
  if (args.video !== undefined) {
    const seconds = Number(args.video)
    if (!(seconds > 0)) throw new Error('--video needs a positive number of seconds')
    args.video = Math.min(seconds, 10)
  }
  return args
}

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exit(2)
}

const aborted = []
const result = { file: path.resolve(args.out), status: null, finalUrl: null, role: args.as, consent: false, forced: args.force || null, experiments: [], aborted }
let exitCode = 0
const browser = await launchBrowser()
let videoDir
try {
  const contextOptions = {
    userAgent: USER_AGENT,
    viewport: args.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  }
  if (args.mobile) Object.assign(contextOptions, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  if (args.as !== 'anon') {
    const state = statePath(args.as)
    if (!fs.existsSync(state)) throw new Error(`No saved session for ${args.as}; run node bin/login.mjs ${args.as} first`)
    contextOptions.storageState = state
  }
  if (args.video) {
    videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-video-'))
    contextOptions.viewport = { width: 1280, height: 720 }
    contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } }
  }
  const context = await browser.newContext(contextOptions)
  await installGuard(context, aborted)
  const page = await context.newPage()

  const url = new URL(absoluteUrl(args.url))
  if (args.force) url.searchParams.append('_conv_eforce', args.force)
  const started = Date.now()
  const response = await page.goto(url.toString(), { waitUntil: 'load', timeout: 45000 })
  result.status = response ? response.status() : null
  if (result.status === 401) throw new Error('HTTP 401 (basic auth missing)')
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
  result.consent = await grantConsent(page)
  await slowScroll(page)
  await page.waitForTimeout(500)
  result.finalUrl = page.url()
  result.experiments = await page.evaluate(() =>
    Array.from(document.documentElement.attributes)
      .filter((attr) => attr.name.startsWith('data-convert'))
      .map((attr) => ({ name: attr.name, value: attr.value })),
  )

  fs.mkdirSync(path.dirname(result.file), { recursive: true })
  if (args.video) {
    const remaining = args.video * 1000 - (Date.now() - started)
    if (remaining > 0) await page.waitForTimeout(remaining)
    const video = page.video()
    await context.close()
    const target = result.file.endsWith('.webm') ? result.file : `${result.file}.webm`
    await video.saveAs(target)
    result.file = target
  } else {
    if (args.selector) {
      const element = page.locator(args.selector).first()
      await element.waitFor({ state: 'visible', timeout: 10000 })
      await element.scrollIntoViewIfNeeded()
      await element.screenshot({ path: result.file })
    } else {
      await page.screenshot({ path: result.file, fullPage: args.full })
    }
    await context.close()
  }
  if (result.status && result.status >= 400) exitCode = 1
} catch (error) {
  result.error = String(error && error.message ? error.message : error).split('\n')[0]
  exitCode = 1
} finally {
  await browser.close()
  if (videoDir) fs.rmSync(videoDir, { recursive: true, force: true })
}
console.log(JSON.stringify(result))
process.exit(exitCode)
