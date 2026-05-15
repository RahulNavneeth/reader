/**
 * Minimal in-memory job tracker. The goal isn't a durable queue (a
 * single-process Reader doesn't need one); it's giving the admin UI a view
 * of work that's currently in flight, plus recent failures.
 *
 * Each long-running async task — currently ingestDocument — wraps itself in
 * `runJob(...)`. We keep the most recent N jobs (including completed) so the
 * admin panel can show a feed; older entries are evicted.
 */
import { nanoid } from 'nanoid'

const MAX_ENTRIES = 200

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

export type Job = {
  id: string
  type: string
  target?: string
  status: JobStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  error?: string
}

const jobs = new Map<string, Job>()

function gc() {
  if (jobs.size <= MAX_ENTRIES) return
  const arr = Array.from(jobs.values()).sort((a, b) => a.createdAt - b.createdAt)
  const drop = arr.length - MAX_ENTRIES
  for (let i = 0; i < drop; i++) jobs.delete(arr[i].id)
}

export async function runJob<T>(
  type: string,
  target: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const id = nanoid()
  const created = Date.now()
  const job: Job = { id, type, target, status: 'pending', createdAt: created }
  jobs.set(id, job)
  gc()
  job.status = 'running'
  job.startedAt = Date.now()
  try {
    const out = await fn()
    job.status = 'completed'
    job.finishedAt = Date.now()
    job.durationMs = job.finishedAt - (job.startedAt ?? created)
    return out
  } catch (e: any) {
    job.status = 'failed'
    job.error = e?.message ?? String(e)
    job.finishedAt = Date.now()
    job.durationMs = job.finishedAt - (job.startedAt ?? created)
    throw e
  }
}

export function listJobs(opts?: { status?: JobStatus; limit?: number }): Job[] {
  const limit = Math.min(opts?.limit ?? 100, MAX_ENTRIES)
  let arr = Array.from(jobs.values())
  if (opts?.status) arr = arr.filter((j) => j.status === opts.status)
  arr.sort((a, b) => b.createdAt - a.createdAt)
  return arr.slice(0, limit)
}

export function jobCounts(): Record<JobStatus, number> {
  const counts: Record<JobStatus, number> = { pending: 0, running: 0, completed: 0, failed: 0 }
  for (const j of jobs.values()) counts[j.status]++
  return counts
}
