// Side-effect-only module: load `.env` from the repo root BEFORE any
// other module touches `process.env`. ESM hoists all imports of an
// entry file ahead of its top-level code, so we can't inline this in
// `index.ts` and expect `config.ts` (also imported) to see the loaded
// vars — by the time inline code runs, `config.ts` has already
// evaluated. Putting it in its own module + importing it FIRST in
// `index.ts` guarantees it runs before any `import { config }` chain.
//
// In production `.env` doesn't exist at the repo root; env vars come
// from the container/host. `loadEnvFile` throws on missing files, so
// we swallow that to keep prod boots quiet.
//
// `loadEnvFile` is Node 20.6+.
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

try {
  const here = dirname(fileURLToPath(import.meta.url))
  const envPath = resolve(here, '../../../.env')
  const had = !!process.env.SESSION_SECRET
  ;(process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile?.(
    envPath,
  )
  // eslint-disable-next-line no-console
  console.log(
    `[loadEnv] ${envPath} — SESSION_SECRET was ${had ? 'preset' : 'unset'}, now ${
      process.env.SESSION_SECRET ? 'set (' + process.env.SESSION_SECRET.length + ' chars)' : 'still unset'
    }`,
  )
} catch (e) {
  // eslint-disable-next-line no-console
  console.log('[loadEnv] failed:', (e as Error)?.message)
}
