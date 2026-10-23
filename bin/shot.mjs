#!/usr/bin/env node
// Opens a staging page as a role and saves a screenshot or a short video.
// Usage: node bin/shot.mjs --as <anon|user|academy|admin> --url <path> --out <file>
//          [--mobile] [--full] [--selector <css>] [--video <seconds>] [--force <experiment id>.<variant id>]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CHROME_USER_AGENT,
  ROLES,
  USER_AGENT,
  absoluteUrl,
  grantConsent,
  installGuard,
  launchBrowser,
  slowScroll,
  statePath,
} from './browser.mjs'

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
  if (args.force !== undefined) {
    const match = /^([^.]+)\.([^.]+)$/.exec(args.force)
    if (!match) throw new Error('--force needs <experiment id>.<variant id>')
    args.experiment = match[1]
    args.variant = match[2]
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
const result = {
  file: path.resolve(args.out),
  status: null,
  finalUrl: null,
  role: args.as,
  consent: false,
  forced: args.force || null,
  forceApplied: null,
  forceMethod: null,
  experiments: [],
  aborted,
}

function contextOptions() {
  const options = {
    userAgent: args.force ? CHROME_USER_AGENT : USER_AGENT,
    viewport: args.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  }
  if (args.mobile) Object.assign(options, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  if (args.as !== 'anon') {
    const state = statePath(args.as)
    if (!fs.existsSync(state)) throw new Error(`No saved session for ${args.as}; run node bin/login.mjs ${args.as} first`)
    options.storageState = state
  }
  return options
}

function targetUrl(method) {
  const url = new URL(absoluteUrl(args.url))
  if (method === 'vpreview') {
    url.searchParams.set('convert_action', 'convert_vpreview')
    url.searchParams.set('convert_e', args.experiment)
    url.searchParams.set('convert_v', args.variant)
  } else if (method === 'eforce') {
    url.searchParams.set('_conv_eforce', args.force)
  }
  return url.toString()
}

async function waitForVariant(page) {
  const attribute = `data-convert-${args.experiment}`
  return page
    .waitForFunction(
      ([name, value]) => document.documentElement.getAttribute(name) === value,
      [attribute, args.variant],
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false)
}

// Opens the page in a fresh context. Returns the open context and page, or closes the context
// and returns null when a forced variant did not become active.
async function open(browser, method, options) {
  const context = await browser.newContext(options)
  await installGuard(context, aborted)
  const page = await context.newPage()
  const response = await page.goto(targetUrl(method), { waitUntil: 'load', timeout: 45000 })
  result.status = response ? response.status() : null
  if (result.status === 401) throw new Error('HTTP 401 (basic auth missing)')
  if (method) {
    const applied = await waitForVariant(page)
    if (!applied) {
      await context.close()
      return null
    }
  }
  return { context, page }
}

let exitCode = 0
const browser = await launchBrowser()
const videoDirs = []
try {
  const started = Date.now()
  const makeOptions = () => {
    const options = contextOptions()
    if (args.video) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-video-'))
      videoDirs.push(dir)
      options.viewport = { width: 1280, height: 720 }
      options.recordVideo = { dir, size: { width: 1280, height: 720 } }
    }
    return options
  }

  let opened
  if (args.force) {
    for (const method of ['vpreview', 'eforce']) {
      opened = await open(browser, method, makeOptions())
      if (opened) {
        result.forceApplied = true
        result.forceMethod = method
        break
      }
    }
    if (!opened) {
      result.forceApplied = false
      opened = await open(browser, null, makeOptions())
    }
  } else {
    opened = await open(browser, null, makeOptions())
  }
  const { context, page } = opened

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
  for (const dir of videoDirs) fs.rmSync(dir, { recursive: true, force: true })
}
console.log(JSON.stringify(result))
process.exit(exitCode)
