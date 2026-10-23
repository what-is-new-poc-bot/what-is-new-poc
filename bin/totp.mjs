#!/usr/bin/env node
// RFC 6238 TOTP (base32 secret, SHA-1, 30 s step) using Node's crypto.
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index === -1) throw new Error('Invalid base32 character in secret')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totp(secret, { time = Date.now() / 1000, step = 30, digits = 6 } = {}) {
  const counter = Math.floor(time / step)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(code).padStart(digits, '0')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const secret = process.env.REPORT_ADMIN_TOTP_SECRET
  if (!secret) {
    console.error('REPORT_ADMIN_TOTP_SECRET is not set')
    process.exit(1)
  }
  console.log(totp(secret))
}
