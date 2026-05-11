import { hash, verify } from '@node-rs/argon2'

// @node-rs/argon2 defaults to Argon2id; we just tune cost params.
const argonOptions = {
  memoryCost: 19456, // 19 MB — OWASP 2023 baseline
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error('password too short')
  return hash(password, argonOptions)
}

export async function verifyPassword(stored: string, candidate: string): Promise<boolean> {
  try {
    return await verify(stored, candidate)
  } catch {
    return false
  }
}
