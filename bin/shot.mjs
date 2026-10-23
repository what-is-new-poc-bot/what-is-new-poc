#!/usr/bin/env node
// Opens a staging page as a role and saves a screenshot or a short video.
// Usage: node bin/shot.mjs --as <anon|user|academy|admin> --url <path> --out <file>
//          [--mobile] [--full] [--selector <css>] [--video <seconds>] [--actions <file>]
//          [--poll-for <css>] [--force <experiment id>.<variant id>]
import { execFileSync } from 'node:child_process'
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
    else if (['--as', '--url', '--out', '--selector', '--video', '--actions', '--poll-for', '--force'].includes(arg)) args[arg.slice(2).replace('-for', 'For')] = argv[++i]
    else throw new Error(`Unknown argument ${arg}`)
  }
  if (!args.as || !args.url || !args.out) throw new Error('--as, --url and --out are required')
  if (args.as !== 'anon' && !ROLES.includes(args.as)) throw new Error('--as must be anon, user, academy or admin')
  if (args.video !== undefined) {
    const seconds = Number(args.video)
    if (!(seconds > 0)) throw new Error('--video needs a positive number of seconds')
    args.video = Math.min(seconds, 10)
  }
  if (args.actions !== undefined) args.steps = loadSteps(args.actions)
  if (args.force !== undefined) {
    const match = /^([^.]+)\.([^.]+)$/.exec(args.force)
    if (!match) throw new Error('--force needs <experiment id>.<variant id>')
    args.experiment = match[1]
    args.variant = match[2]
  }
  return args
}

const STEP_KINDS = ['click', 'hover', 'type', 'press', 'scroll', 'wait', 'waitFor']

function loadSteps(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(steps)) throw new Error('--actions file must contain a JSON list of steps')
  for (const step of steps) {
    const keys = step && typeof step === 'object' ? Object.keys(step) : []
    if (keys.length !== 1 || !STEP_KINDS.includes(keys[0])) throw new Error(`Invalid action step ${JSON.stringify(step)}`)
    if (keys[0] === 'type' && !(Array.isArray(step.type) && step.type.length === 2)) {
      throw new Error('A type step needs ["<css>", "<text>"]')
    }
  }
  return steps
}

async function runStep(page, step) {
  const [kind] = Object.keys(step)
  const value = step[kind]
  const timeout = 5000
  if (kind === 'click') await page.locator(value).first().click({ timeout })
  else if (kind === 'hover') await page.locator(value).first().hover({ timeout })
  else if (kind === 'type') await page.locator(value[0]).first().pressSequentially(String(value[1]), { delay: 60, timeout })
  else if (kind === 'press') await page.keyboard.press(value)
  else if (kind === 'scroll') await page.mouse.wheel(0, Number(value))
  else if (kind === 'wait') await page.waitForTimeout(Math.min(Number(value), 10000))
  else if (kind === 'waitFor') await page.locator(value).first().waitFor({ state: 'visible', timeout })
  if (kind === 'scroll') await page.waitForTimeout(400)
}

// Runs the steps in order and stops at the first one that fails.
async function runSteps(page, steps) {
  for (const [index, step] of steps.entries()) {
    console.error(`STEP ${index + 1} ${JSON.stringify(step)}`)
    try {
      if (args.video && videoLeft() <= 0) throw new Error(`video limit of ${args.video} s reached`)
      await runStep(page, step)
      result.actions.push(step)
    } catch (error) {
      result.actionError = `step ${index + 1} ${JSON.stringify(step)}: ${String(error.message || error).split('\n')[0]}`
      console.error(`STEP ${index + 1} failed`)
      return false
    }
  }
  return true
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
  actions: [],
  actionError: null,
  polled: args.pollFor ? { selector: args.pollFor, appeared: false, afterMs: null } : null,
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
  recordingStarted = Date.now()
  await installGuard(context, aborted)
  if (method === 'fake') await fakeConvert(context)
  const page = await context.newPage()
  const waitUntil = args.video ? 'domcontentloaded' : 'load'
  const response = await page.goto(targetUrl(method), { waitUntil, timeout: 45000 })
  // The video's 10 s start shortly before the page is first shown; earlier frames are cut off.
  started = Date.now() - 500
  result.status = response ? response.status() : null
  if (result.status === 401) throw new Error('HTTP 401 (basic auth missing)')
  if (method === 'fake') {
    await page.evaluate(() =>
      document.dispatchEvent(new CustomEvent('convert:experiences:updated', { bubbles: true })),
    )
    await page.waitForTimeout(500)
  }
  if (method) {
    const applied = await waitForVariant(page)
    if (!applied) {
      await context.close()
      return null
    }
  }
  return { context, page }
}

const CONVERT_HOST = /(^|\.)convertexperiments\.com$|^cv\.studyflix\.de$/

// Fakes Convert the way the app's development mode does: the Convert script is not loaded and
// window.convert reports the forced variant before any page script runs.
async function fakeConvert(context) {
  await context.route(
    (url) => CONVERT_HOST.test(url.hostname),
    async (route) => {
      const request = route.request()
      aborted.push({ method: request.method(), url: request.url(), reason: 'Convert script faked' })
      console.error(`ABORTED ${request.method()} ${request.url()}: Convert script faked`)
      await route.abort('blockedbyclient')
    },
  )
  await context.addInitScript(
    ([experiment, variant]) => {
      window._conv_q = []
      window.convert = { currentData: { experiences: { [experiment]: { variation: { id: variant } } } } }
    },
    [args.experiment, args.variant],
  )
}

function ffmpegPath() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  for (const dir of fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.startsWith('ffmpeg')) : []) {
    const candidate = path.join(root, dir, 'ffmpeg-linux')
    if (fs.existsSync(candidate)) return candidate
  }
  return 'ffmpeg'
}

// Cuts the recording to at most `seconds`, starting at `offset` seconds.
function trimVideo(source, target, offset, seconds) {
  execFileSync(
    ffmpegPath(),
    ['-y', '-loglevel', 'error', '-ss', offset.toFixed(2), '-i', source, '-t', String(seconds), '-an',
      '-c:v', 'libvpx', '-b:v', '2M', '-deadline', 'realtime', target],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
}

let exitCode = 0
let started = Date.now()
let recordingStarted = Date.now()
let videoEnd = null
const videoLeft = () => args.video * 1000 - (Date.now() - started)

// Waits up to 30 s for the polled element to become visible.
async function pollFor(page) {
  const since = Date.now()
  const appeared = await page
    .locator(args.pollFor)
    .first()
    .waitFor({ state: 'visible', timeout: 30000 })
    .then(() => true)
    .catch(() => false)
  result.polled.appeared = appeared
  if (appeared) result.polled.afterMs = Date.now() - since
  return appeared
}
const browser = await launchBrowser()
const videoDirs = []
try {
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
    for (const method of ['vpreview', 'fake']) {
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

  // A video has at most 10 s, so it waits less for the network to settle.
  await page.waitForLoadState('networkidle', { timeout: args.video ? 1500 : 8000 }).catch(() => {})
  result.consent = await grantConsent(page)
  // In a video with steps, the recording time goes to the steps instead of the scroll; a polled
  // element must be caught the moment it shows up.
  if (!(args.video && args.steps) && !args.pollFor) {
    await slowScroll(page)
    await page.waitForTimeout(500)
  }
  let stepsOk = true
  if (args.steps) {
    stepsOk = await runSteps(page, args.steps)
    if (args.video && stepsOk && !args.pollFor) await page.waitForTimeout(Math.max(0, Math.min(2000, videoLeft())))
  }
  if (args.pollFor && stepsOk) {
    const appeared = await pollFor(page)
    // With a video, the recording runs from load until 3 s after the element appears and keeps
    // the last seconds up to the video limit.
    if (args.video) {
      await page.waitForTimeout(appeared ? 3000 : 0)
      videoEnd = Date.now()
    }
  }
  result.finalUrl = page.url()
  result.experiments = await page.evaluate(() =>
    Array.from(document.documentElement.attributes)
      .filter((attr) => attr.name.startsWith('data-convert'))
      .map((attr) => ({ name: attr.name, value: attr.value })),
  )

  fs.mkdirSync(path.dirname(result.file), { recursive: true })
  if (args.video) {
    if (!args.steps && !args.pollFor && videoLeft() > 0) await page.waitForTimeout(videoLeft())
    const video = page.video()
    await context.close()
    const target = result.file.endsWith('.webm') ? result.file : `${result.file}.webm`
    const raw = path.join(videoDirs[videoDirs.length - 1], 'raw.webm')
    await video.saveAs(raw)
    const from = videoEnd ? Math.max(started, videoEnd - args.video * 1000) : started
    const length = videoEnd ? Math.min(args.video, (videoEnd - from) / 1000) : args.video
    trimVideo(raw, target, Math.max(0, (from - recordingStarted) / 1000), Number(length.toFixed(2)))
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
  if (!stepsOk) exitCode = 1
} catch (error) {
  result.error = String(error && error.message ? error.message : error).split('\n')[0]
  exitCode = 1
} finally {
  await browser.close()
  for (const dir of videoDirs) fs.rmSync(dir, { recursive: true, force: true })
}
console.log(JSON.stringify(result))
process.exit(exitCode)
