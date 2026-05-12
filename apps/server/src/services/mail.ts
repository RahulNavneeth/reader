import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'

let cached: { signature: string; transporter: Transporter } | null = null

function signature(): string {
  const s = config.smtp
  return `${s.host}|${s.port}|${s.user}|${s.secure}`
}

function getTransporter(): Transporter | null {
  const s = config.smtp
  if (!s.enabled) return null
  if (!s.host) return null
  if (cached && cached.signature === signature()) return cached.transporter
  const transporter = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
  })
  cached = { signature: signature(), transporter }
  return transporter
}

export async function verifySmtp(): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = getTransporter()
  if (!t) return { ok: false, error: 'SMTP is disabled or unconfigured' }
  try {
    await t.verify()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

export type MailMessage = {
  to: string
  subject: string
  text: string
  html?: string
}

export async function sendMail(msg: MailMessage): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const t = getTransporter()
  if (!t) {
    // No transport configured — fall back to logging so dev/test environments
    // don't crash when a feature tries to email something.
    console.warn('[mail] SMTP not configured, would have sent:', {
      to: msg.to,
      subject: msg.subject,
    })
    return { ok: false, error: 'SMTP not configured' }
  }
  try {
    const result = await t.sendMail({
      from: config.smtp.from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    })
    return { ok: true, id: result.messageId ?? '' }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

export function invalidateMailCache(): void {
  cached = null
}
