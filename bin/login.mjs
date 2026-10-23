#!/usr/bin/env node
// Logs a report account in through the normal form and saves its storage state to .state/<role>.json.
// Usage: node bin/login.mjs <user|academy|admin>
import fs from 'node:fs'
import { ROLES, USER_AGENT, STATE_DIR, absoluteUrl, grantConsent, launchBrowser, statePath } from './browser.mjs'
import { totp } from './totp.mjs'

const role = process.argv[2]
if (!ROLES.includes(role)) {
  console.error('Usage: node bin/login.mjs <user|academy|admin>')
  process.exit(2)
}

const prefix = `REPORT_${role.toUpperCase()}`
const email = process.env[`${prefix}_EMAIL`]
const password = process.env[`${prefix}_PASSWORD`]
const otpSecret = role === 'admin' ? process.env.REPORT_ADMIN_TOTP_SECRET : null
const missing = [`${prefix}_EMAIL`, `${prefix}_PASSWORD`, ...(role === 'admin' ? ['REPORT_ADMIN_TOTP_SECRET'] : [])].filter(
  (name) => !process.env[name],
)
if (missing.length) {
  console.error(`Login failed for ${role}: missing environment variables ${missing.join(', ')}`)
  process.exit(1)
}

const signInPath = role === 'admin' ? '/admin/sign_in' : '/users/sign_in'
const browser = await launchBrowser()
let exitCode = 0
try {
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const response = await page.goto(absoluteUrl(signInPath), { waitUntil: 'domcontentloaded' })
  if (response && response.status() === 401) throw new Error('HTTP 401 on sign-in page (basic auth missing)')
  await grantConsent(page)

  const form = page.locator(`form[action="${signInPath}"]`).first()
  await form.locator('input[name="user[email]"]').fill(email)
  await form.locator('input[name="user[password]"]').fill(password)
  const otpField = form.locator('input[name="user[otp_attempt]"]')
  if (otpSecret && (await otpField.count())) await otpField.fill(totp(otpSecret))
  await form.locator('button[type="submit"], input[type="submit"]').first().click()

  const left = await page
    .waitForURL((url) => !url.pathname.endsWith('/sign_in'), { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  const stillOnForm = await page.locator('input[name="user[password]"]').count()
  if (!left || stillOnForm) {
    const flash = (await page.locator('.alert, .flash, .invalid-feedback, .error').allInnerTexts().catch(() => []))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
    throw new Error(`still on the sign-in form${flash ? ` (page says: ${flash})` : ''}`)
  }

  fs.mkdirSync(STATE_DIR, { recursive: true })
  await context.storageState({ path: statePath(role) })
  console.log(JSON.stringify({ role, loggedIn: true, url: page.url(), state: `.state/${role}.json` }))
} catch (error) {
  let message = String(error && error.message ? error.message : error)
  for (const secret of [email, password, otpSecret]) if (secret) message = message.split(secret).join('[redacted]')
  console.error(`Login failed for ${role}: ${message.split('\n')[0]}`)
  exitCode = 1
} finally {
  await browser.close()
}
process.exit(exitCode)
