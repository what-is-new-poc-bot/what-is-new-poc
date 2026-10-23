#!/usr/bin/env node
// Shared browser code for login.mjs and shot.mjs, including the request guard.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const STATE_DIR = path.join(ROOT, '.state')
export const BASE_URL = (process.env.REPORT_BASE_URL || 'https://studyflix-staging.makandra.de').replace(/\/+$/, '')
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
export const USER_AGENT = `${CHROME_USER_AGENT} StudyflixReportBot`
export const ROLES = ['user', 'academy', 'admin']

const BLOCKED_PATH_WORDS = ['delete', 'destroy', 'invite', 'export', 'bulk_import', 'publish', 'unpublish', 'send']

export function adminWriteAllow() {
  return (process.env.REPORT_ADMIN_WRITE_ALLOW || '')
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean)
}

// Returns null when the request may pass, otherwise the reason for aborting it.
export function guardDecision({ method, url, headers = {}, postData = '' }, allow = adminWriteAllow()) {
  const verb = String(method || 'GET').toUpperCase()
  let pathname
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = String(url)
  }
  const lowerPath = pathname.toLowerCase()
  const override = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-http-method-override')

  if (verb === 'DELETE') return 'DELETE request'
  if (verb !== 'GET' && /(^|&)_method=delete(&|$)/i.test(decodeBody(postData))) return 'POST with _method=delete'
  if (override && String(override[1]).trim().toUpperCase() === 'DELETE') return 'X-HTTP-Method-Override: DELETE'
  if (verb !== 'GET') {
    const word = BLOCKED_PATH_WORDS.find((w) => lowerPath.includes(w))
    if (word) return `non-GET request to a path containing "${word}"`
    if (/^\/admin(\/|$)/.test(lowerPath) && !allow.some((prefix) => pathname.startsWith(prefix))) {
      return 'non-GET request to /admin outside REPORT_ADMIN_WRITE_ALLOW'
    }
  }
  return null
}

function decodeBody(body) {
  const text = String(body || '')
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

export async function installGuard(context, aborted) {
  await context.route('**/*', async (route) => {
    const request = route.request()
    const reason = guardDecision({
      method: request.method(),
      url: request.url(),
      headers: request.headers(),
      postData: request.postData() || '',
    })
    if (reason) {
      aborted.push({ method: request.method(), url: request.url(), reason })
      console.error(`ABORTED ${request.method()} ${request.url()}: ${reason}`)
      await route.abort('blockedbyclient')
    } else {
      await route.continue()
    }
  })
}

export function loadPlaywright() {
  const candidates = ['playwright', '/opt/node22/lib/node_modules/playwright']
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch {}
  }
  throw new Error('Playwright not found (expected under /opt/node22/lib/node_modules)')
}

export async function launchBrowser() {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/opt/pw-browsers'
  const { chromium } = loadPlaywright()
  const options = { headless: true }
  if (process.env.HTTPS_PROXY) options.proxy = { server: process.env.HTTPS_PROXY }
  return chromium.launch(options)
}

export function statePath(role) {
  return path.join(STATE_DIR, `${role}.json`)
}

export function absoluteUrl(target) {
  if (/^https?:\/\//.test(target)) return target
  return BASE_URL + (target.startsWith('/') ? target : `/${target}`)
}

// Grants consent if Didomi shows up within the timeout. Returns true when consent was granted.
export async function grantConsent(page, timeout = 5000) {
  try {
    await page.waitForFunction(() => window.Didomi && typeof window.Didomi.setUserAgreeToAll === 'function', null, {
      timeout,
    })
    await page.evaluate(() => window.Didomi.setUserAgreeToAll())
    await page.waitForTimeout(500)
    return true
  } catch {
    return false
  }
}

export async function slowScroll(page) {
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const step = Math.max(200, Math.floor(window.innerHeight * 0.6))
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40000; y += step) {
      window.scrollTo(0, y)
      await sleep(150)
    }
    window.scrollTo(0, document.documentElement.scrollHeight)
    await sleep(400)
    window.scrollTo(0, 0)
    await sleep(300)
  })
}

function selftest() {
  const base = 'https://studyflix-staging.makandra.de'
  const allow = ['/admin/allowed']
  const cases = [
    ['DELETE', { method: 'DELETE', url: `${base}/users/1` }, true],
    ['POST _method=delete', { method: 'POST', url: `${base}/users/1`, postData: 'a=1&_method=delete' }, true],
    ['POST _method=DELETE encoded', { method: 'POST', url: `${base}/x`, postData: '_method=DELETE&b=2' }, true],
    ['override header', { method: 'POST', url: `${base}/x`, headers: { 'X-HTTP-Method-Override': 'DELETE' } }, true],
    ['GET override header', { method: 'GET', url: `${base}/x`, headers: { 'x-http-method-override': 'delete' } }, true],
    ...BLOCKED_PATH_WORDS.map((w) => [`POST ${w}`, { method: 'POST', url: `${base}/things/1/${w}` }, true]),
    ['PATCH publish', { method: 'PATCH', url: `${base}/videos/1/publish` }, true],
    ['POST admin', { method: 'POST', url: `${base}/admin/users` }, true],
    ['PUT admin', { method: 'PUT', url: `${base}/admin/settings/1` }, true],
    ['POST admin allowed', { method: 'POST', url: `${base}/admin/allowed/new` }, false],
    ['POST admin allowed but destroy', { method: 'POST', url: `${base}/admin/allowed/1/destroy` }, true],
    ['GET admin', { method: 'GET', url: `${base}/admin/users` }, false],
    ['GET with delete in path', { method: 'GET', url: `${base}/admin/users/1/delete` }, false],
    ['GET page', { method: 'GET', url: `${base}/` }, false],
    ['POST sign in', { method: 'POST', url: `${base}/users/sign_in`, postData: 'user%5Bemail%5D=x' }, false],
    ['POST admin sign in (allowed by prefix)', { method: 'POST', url: `${base}/admin/sign_in` }, false, ['/admin/sign_in']],
    ['POST admin sign in (no allow list)', { method: 'POST', url: `${base}/admin/sign_in` }, true, []],
    ['POST tracking', { method: 'POST', url: 'https://example.com/collect', postData: 'event=view' }, false],
  ]
  for (const [name, request, shouldBlock, allowList = allow] of cases) {
    const blocked = guardDecision(request, allowList) !== null
    if (blocked !== shouldBlock) {
      console.log(`selftest failed: ${name} (expected ${shouldBlock ? 'blocked' : 'allowed'})`)
      process.exit(1)
    }
  }
  console.log('selftest ok')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--selftest')) selftest()
  else {
    console.error('Usage: node bin/browser.mjs --selftest')
    process.exit(1)
  }
}
