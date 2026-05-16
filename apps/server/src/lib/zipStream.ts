/**
 * Tiny streaming ZIP encoder — store-only (no DEFLATE). The vault is
 * mostly already-compressed binary (PDF, JPEG, MP4) where DEFLATE buys
 * <2% but adds CPU + a dep. Store-only is fine.
 *
 * Emits a valid ZIP per APPNOTE.TXT 6.3.4:
 *   - Local file header + raw data per entry
 *   - Central directory record per entry at the tail
 *   - End-of-central-directory record
 *
 * Streamed via an async generator: caller pipes chunks to the HTTP
 * response without buffering the whole archive. Uses ZIP64 fields when
 * any entry or the archive itself exceeds 4 GiB (Node's CRC32 from
 * `node:zlib`).
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { crc32 } from 'node:zlib'

const SIG_LOCAL_FILE = 0x04034b50
const SIG_CENTRAL_DIR = 0x02014b50
const SIG_END_CENTRAL = 0x06054b50
const SIG_ZIP64_END_CENTRAL = 0x06064b50
const SIG_ZIP64_END_LOCATOR = 0x07064b50

const ZIP64_MAGIC = 0xffffffff

type Entry = {
  /** Path inside the archive (forward slashes). */
  name: string
} & ({ type: 'file'; absPath: string } | { type: 'buffer'; data: Buffer })

type Recorded = {
  name: Buffer
  crc: number
  size: number
  /** Where in the stream the local-header started. */
  offset: number
  mtime: Date
  needsZip64: boolean
}

function dosTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n, 0)
  return b
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}
function u64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n), 0)
  return b
}

export async function* zipStream(entries: AsyncIterable<Entry>): AsyncGenerator<Buffer> {
  let offset = 0
  const recorded: Recorded[] = []

  for await (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const mtime = new Date()
    const { time, date } = dosTime(mtime)
    let size = 0
    let crc = 0

    // Determine size + CRC by streaming or buffering.
    let dataChunks: Buffer[] | null = null
    if (entry.type === 'buffer') {
      crc = crc32(entry.data) >>> 0
      size = entry.data.length
      dataChunks = [entry.data]
    } else {
      // For files: stat for size, then stream twice — once for CRC, once
      // for the actual write. Streaming twice avoids loading large blobs
      // into memory. Cheaper than computing both on a single pass with a
      // pass-through that buffers everything.
      const st = await stat(entry.absPath)
      size = st.size
      // CRC pass.
      const stream = createReadStream(entry.absPath)
      let running = 0
      for await (const chunk of stream) {
        running = crc32(chunk as Buffer, running) >>> 0
      }
      crc = running
    }

    const needsZip64 = size >= ZIP64_MAGIC || offset >= ZIP64_MAGIC
    // Local file header — write extra field for ZIP64 when needed.
    const extra = needsZip64
      ? Buffer.concat([
          u16(0x0001), // ZIP64 extra-field tag
          u16(16), // size
          u64(size),
          u64(size),
        ])
      : Buffer.alloc(0)
    const versionNeeded = needsZip64 ? 45 : 20
    const generalPurpose = 0x0800 // bit 11: filename is UTF-8.
    const compressionMethod = 0
    const localHeader = Buffer.concat([
      u32(SIG_LOCAL_FILE),
      u16(versionNeeded),
      u16(generalPurpose),
      u16(compressionMethod),
      u16(time),
      u16(date),
      u32(crc),
      u32(needsZip64 ? ZIP64_MAGIC : size),
      u32(needsZip64 ? ZIP64_MAGIC : size),
      u16(nameBuf.length),
      u16(extra.length),
      nameBuf,
      extra,
    ])
    yield localHeader
    const headerOffset = offset
    offset += localHeader.length

    // Data.
    if (dataChunks) {
      for (const c of dataChunks) {
        yield c
        offset += c.length
      }
    } else {
      const stream = createReadStream((entry as { absPath: string }).absPath)
      for await (const chunk of stream) {
        const buf = chunk as Buffer
        yield buf
        offset += buf.length
      }
    }

    recorded.push({ name: nameBuf, crc, size, offset: headerOffset, mtime, needsZip64 })
  }

  // Central directory.
  const cdStart = offset
  for (const r of recorded) {
    const { time, date } = dosTime(r.mtime)
    const needsOffsetZip64 = r.offset >= ZIP64_MAGIC
    const needsAnyZip64 = r.needsZip64 || needsOffsetZip64
    const extraParts: Buffer[] = []
    if (needsAnyZip64) {
      extraParts.push(u16(0x0001))
      let payload = Buffer.alloc(0)
      if (r.needsZip64) {
        payload = Buffer.concat([payload, u64(r.size), u64(r.size)])
      }
      if (needsOffsetZip64) {
        payload = Buffer.concat([payload, u64(r.offset)])
      }
      extraParts.push(u16(payload.length))
      extraParts.push(payload)
    }
    const extra = Buffer.concat(extraParts)
    const versionMadeBy = 45 << 0
    const versionNeeded = needsAnyZip64 ? 45 : 20
    const generalPurpose = 0x0800
    const cdHeader = Buffer.concat([
      u32(SIG_CENTRAL_DIR),
      u16(versionMadeBy),
      u16(versionNeeded),
      u16(generalPurpose),
      u16(0), // compression method (stored)
      u16(time),
      u16(date),
      u32(r.crc),
      u32(r.needsZip64 ? ZIP64_MAGIC : r.size),
      u32(r.needsZip64 ? ZIP64_MAGIC : r.size),
      u16(r.name.length),
      u16(extra.length),
      u16(0), // comment length
      u16(0), // disk number
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(needsOffsetZip64 ? ZIP64_MAGIC : r.offset),
      r.name,
      extra,
    ])
    yield cdHeader
    offset += cdHeader.length
  }
  const cdSize = offset - cdStart

  const archiveZip64 = cdStart >= ZIP64_MAGIC || cdSize >= ZIP64_MAGIC || recorded.length >= 0xffff
  if (archiveZip64) {
    // ZIP64 end-of-central-directory record.
    const zip64End = Buffer.concat([
      u32(SIG_ZIP64_END_CENTRAL),
      u64(44), // size of this record minus 12
      u16(45),
      u16(45),
      u32(0), // this disk
      u32(0), // central dir disk
      u64(recorded.length),
      u64(recorded.length),
      u64(cdSize),
      u64(cdStart),
    ])
    yield zip64End
    const zip64EndOffset = offset
    offset += zip64End.length

    // ZIP64 end-of-central-directory locator.
    const zip64Locator = Buffer.concat([
      u32(SIG_ZIP64_END_LOCATOR),
      u32(0),
      u64(zip64EndOffset),
      u32(1),
    ])
    yield zip64Locator
    offset += zip64Locator.length
  }

  const end = Buffer.concat([
    u32(SIG_END_CENTRAL),
    u16(0),
    u16(0),
    u16(Math.min(recorded.length, 0xffff)),
    u16(Math.min(recorded.length, 0xffff)),
    u32(Math.min(cdSize, ZIP64_MAGIC)),
    u32(Math.min(cdStart, ZIP64_MAGIC)),
    u16(0),
  ])
  yield end
}
