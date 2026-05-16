import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zipStream } from './zipStream.js'

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of it) chunks.push(c)
  return Buffer.concat(chunks)
}

// Tiny ZIP central-directory walker — enough to assert the archive
// holds the right entry names + uncompressed sizes. We're not
// validating CRC here; that's covered by the round-trip via `unzip`.
function readCentralDirectory(buf: Buffer): Array<{ name: string; size: number }> {
  const SIG = 0x02014b50
  const out: Array<{ name: string; size: number }> = []
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) !== SIG) continue
    const nameLen = buf.readUInt16LE(i + 28)
    const extraLen = buf.readUInt16LE(i + 30)
    const size = buf.readUInt32LE(i + 24)
    const name = buf.subarray(i + 46, i + 46 + nameLen).toString('utf8')
    out.push({ name, size })
    i += 46 + nameLen + extraLen - 1
  }
  return out
}

describe('zipStream', () => {
  it('emits an empty-but-valid archive when given zero entries', async () => {
    const buf = await collect(zipStream((async function* () {})()))
    // EOCD = end-of-central-directory record signature.
    expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50)
  })

  it('packs buffer entries and round-trips file names + sizes', async () => {
    const buf = await collect(
      zipStream(
        (async function* () {
          yield { name: 'a.txt', type: 'buffer', data: Buffer.from('hello') }
          yield { name: 'sub/b.bin', type: 'buffer', data: Buffer.alloc(128, 0xab) }
        })(),
      ),
    )
    const entries = readCentralDirectory(buf)
    expect(entries.length).toBe(2)
    expect(entries[0]).toEqual({ name: 'a.txt', size: 5 })
    expect(entries[1]).toEqual({ name: 'sub/b.bin', size: 128 })
  })

  it('packs on-disk file entries', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-zip-'))
    try {
      const f = path.join(dir, 'photo.jpg')
      await writeFile(f, Buffer.alloc(2048, 0x42))
      const buf = await collect(
        zipStream(
          (async function* () {
            yield { name: 'photo.jpg', type: 'file', absPath: f }
          })(),
        ),
      )
      const entries = readCentralDirectory(buf)
      expect(entries).toEqual([{ name: 'photo.jpg', size: 2048 }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
