/**
 * Pluggable blob storage. Backed by the local filesystem (under data/blobs/)
 * by default; switchable to S3 / MinIO via STORAGE=s3 + S3_* env vars.
 */
import path from 'node:path'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { Client as MinioClient, type ClientOptions } from 'minio'
import { config } from '../config.js'

export interface Storage {
  put(key: string, data: Buffer | NodeJS.ReadableStream, mime: string): Promise<{ size: number }>
  getStream(key: string): Promise<NodeJS.ReadableStream>
  size(key: string): Promise<number>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

class LocalStorage implements Storage {
  constructor(private base: string) {}

  private resolve(key: string): string {
    if (key.includes('..')) throw new Error('invalid key')
    return path.join(this.base, key)
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream): Promise<{ size: number }> {
    const fp = this.resolve(key)
    await mkdir(path.dirname(fp), { recursive: true })
    if (Buffer.isBuffer(data)) {
      const ws = createWriteStream(fp)
      await pipeline(Readable.from(data), ws)
    } else {
      await pipeline(data, createWriteStream(fp))
    }
    const s = await stat(fp)
    return { size: s.size }
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return createReadStream(this.resolve(key))
  }

  async size(key: string): Promise<number> {
    const s = await stat(this.resolve(key))
    return s.size
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key))
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key))
      return true
    } catch {
      return false
    }
  }
}

class S3Storage implements Storage {
  private client: MinioClient
  private bucket: string

  constructor(opts: { endpoint: string; accessKey: string; secretKey: string; bucket: string; region: string; forcePathStyle: boolean }) {
    const url = new URL(opts.endpoint)
    const clientOpts: ClientOptions = {
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      useSSL: url.protocol === 'https:',
      accessKey: opts.accessKey,
      secretKey: opts.secretKey,
      region: opts.region,
      pathStyle: opts.forcePathStyle,
    }
    this.client = new MinioClient(clientOpts)
    this.bucket = opts.bucket
  }

  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket).catch(() => false)
    if (!exists) await this.client.makeBucket(this.bucket)
  }

  async put(key: string, data: Buffer | NodeJS.ReadableStream, mime: string): Promise<{ size: number }> {
    if (Buffer.isBuffer(data)) {
      await this.client.putObject(this.bucket, key, data, data.length, { 'Content-Type': mime })
      return { size: data.length }
    }
    // Stream upload — let minio determine length.
    const res = await this.client.putObject(this.bucket, key, data as Readable, undefined, { 'Content-Type': mime })
    const stat = await this.client.statObject(this.bucket, key)
    void res
    return { size: stat.size }
  }

  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(this.bucket, key)
  }

  async size(key: string): Promise<number> {
    const s = await this.client.statObject(this.bucket, key)
    return s.size
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.removeObject(this.bucket, key)
    } catch (e: any) {
      if (e?.code !== 'NoSuchKey' && e?.code !== 'NotFound') throw e
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.statObject(this.bucket, key)
      return true
    } catch {
      return false
    }
  }
}

let cached: Storage | null = null

export async function getStorage(): Promise<Storage> {
  if (cached) return cached
  if (config.storage.backend === 's3') {
    if (!config.storage.s3.endpoint || !config.storage.s3.accessKey || !config.storage.s3.secretKey) {
      throw new Error('STORAGE=s3 but S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY not set')
    }
    const s3 = new S3Storage(config.storage.s3)
    await s3.ensureBucket()
    cached = s3
  } else {
    cached = new LocalStorage(config.paths.blobs)
  }
  return cached
}
