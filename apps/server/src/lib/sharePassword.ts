/**
 * scrypt-based password hashing for share-style configs. Same scheme used
 * for the original /s/<token> share links; lifted into its own module so
 * both DocumentMeta.publicPasswordHash and any future cross-user share
 * grants can share the verifier.
 */
import crypto from 'node:crypto'

const SCRYPT_N = 1 << 14
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const digest = crypto.scryptSync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return `${salt.toString('hex')}:${digest.toString('hex')}`
}

export function verifyPassword(stored: string, candidate: string): boolean {
  const [saltHex, digestHex] = stored.split(':')
  if (!saltHex || !digestHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(digestHex, 'hex')
  const actual = crypto.scryptSync(candidate, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
