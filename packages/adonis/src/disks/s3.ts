import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  CopyOptions,
  Disk,
  DiskCapabilities,
  DiskMetaData,
  DiskStat,
  DiskWriteOptions,
  ExtendedDisk,
  ListEntry,
  ListOptions,
  ListResult,
  MultipartPart,
  MultipartUploadDisk,
  SignedUrlOptions,
} from '../types.js';
import { extractListObjectsV2FromXml, isXmlEntityDeserializationError } from './xml_fallback.js';

/**
 * Construction options for {@link S3Disk}. The {@link S3Client} is built and injected by the
 * `disks.s3()` factory (which lazily imports `@aws-sdk/client-s3`), so this module — and the heavy
 * AWS SDK it pulls in — is only ever loaded when an S3 disk is actually selected.
 */
export interface S3DiskOptions {
  /** A configured `@aws-sdk/client-s3` client. */
  client: S3Client;
  /** Target bucket. */
  bucket: string;
  /** Prefix prepended to every key (e.g. `uploads`). Leading/trailing slashes are trimmed. */
  keyPrefix?: string;
  /** Base URL for stable public URLs (CDN or bucket website). When set, {@link S3Disk.getUrl} uses it. */
  publicBaseUrl?: string;
  /** Region — used only to synthesise a virtual-hosted URL when no `publicBaseUrl` is set. */
  region?: string;
  /** Custom endpoint (S3-compatible services). Used for URL synthesis when no `publicBaseUrl` is set. */
  endpoint?: string;
  /** Emit path-style URLs (`endpoint/bucket/key`) instead of virtual-hosted-style. */
  forcePathStyle?: boolean;
}

/** Default presigned-URL lifetime when a caller passes no `expiresIn` (30 minutes). */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 1800;

/** Human-readable duration units accepted in {@link SignedUrlOptions.expiresIn}. */
const DURATION_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

/**
 * Convert Drive's `expiresIn` (a number of seconds, or a string like `'30m'`/`'1h'`/`'45s'`/`'2d'`)
 * into the whole-seconds the S3 request presigner expects.
 */
function toExpiresInSeconds(expiresIn: string | number | undefined): number {
  if (expiresIn === undefined) return DEFAULT_SIGNED_URL_TTL_SECONDS;
  if (typeof expiresIn === 'number') return Math.max(1, Math.round(expiresIn));
  const match = /^(\d+)\s*([smhd])$/.exec(expiresIn.trim());
  if (match) {
    const value = Number(match[1]);
    const unit = DURATION_UNITS[match[2] as string] as number;
    return Math.max(1, value * unit);
  }
  const asNumber = Number(expiresIn);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.round(asNumber);
  return DEFAULT_SIGNED_URL_TTL_SECONDS;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * S3-backed {@link Disk} satisfying the same structural contract as an `@adonisjs/drive` disk, so it
 * is a drop-in for the media-library and attachment layers. Backed by `@aws-sdk/client-s3` (an
 * optional peer). Beyond the base {@link Disk} surface it also implements {@link MultipartUploadDisk}
 * — native S3 multipart, powering the `proxy` and `direct` upload modes — which the upload layer
 * detects structurally (`isMultipartCapable`) rather than through the base contract. It also
 * implements the optional {@link ExtendedDisk} surface (copy/move, batched delete, list, size/stat,
 * plus a {@link DiskCapabilities} descriptor), detected structurally via `isExtendedDisk`.
 */
export class S3Disk implements Disk, MultipartUploadDisk, ExtendedDisk {
  /** Coarse feature descriptor — S3 supports presign, native multipart, and prefix listing. */
  readonly capabilities: DiskCapabilities;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly publicBaseUrl: string | undefined;
  private readonly region: string | undefined;
  private readonly endpoint: string | undefined;
  private readonly forcePathStyle: boolean;

  constructor(options: S3DiskOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.keyPrefix = (options.keyPrefix ?? '').replace(/^\/+|\/+$/g, '');
    this.publicBaseUrl = options.publicBaseUrl;
    this.region = options.region;
    this.endpoint = options.endpoint;
    this.forcePathStyle = options.forcePathStyle ?? false;
    this.capabilities = {
      presign: true,
      multipart: true,
      // A stable public URL can always be synthesised (publicBaseUrl, endpoint, or the regional host).
      publicUrls: true,
      list: true,
    };
  }

  /** Map a logical key to a fully-qualified S3 key, applying the configured prefix. */
  key(path: string): string {
    const clean = path.replace(/^\/+/, '');
    return this.keyPrefix ? `${this.keyPrefix}/${clean}` : clean;
  }

  async put(key: string, contents: Uint8Array, options?: DiskWriteOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: contents,
        ContentType: options?.contentType,
        ACL: options?.visibility === 'public' ? 'public-read' : undefined,
      }),
    );
  }

  async putStream(key: string, contents: Readable, options?: DiskWriteOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        Body: contents,
        ContentType: options?.contentType,
        ACL: options?.visibility === 'public' ? 'public-read' : undefined,
      }),
    );
  }

  async getBytes(key: string): Promise<Uint8Array> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      const bytes = await res.Body?.transformToByteArray();
      if (!bytes) throw new Error(`S3Disk: empty body for key: ${key}`);
      return bytes;
    } catch (err) {
      if (isNotFound(err)) throw new Error(`S3Disk: file not found: ${key}`);
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      if (!res.Body) throw new Error(`S3Disk: file not found: ${key}`);
      return res.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new Error(`S3Disk: file not found: ${key}`);
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(key) }));
  }

  async getUrl(key: string): Promise<string> {
    const objectKey = this.key(key);
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/+$/, '')}/${objectKey}`;
    }
    if (this.endpoint) {
      const base = this.endpoint.replace(/\/+$/, '');
      if (this.forcePathStyle) return `${base}/${this.bucket}/${objectKey}`;
      const withHost = base.replace(/^(https?:\/\/)/, `$1${this.bucket}.`);
      return `${withHost}/${objectKey}`;
    }
    const region = this.region ?? 'us-east-1';
    return `https://${this.bucket}.s3.${region}.amazonaws.com/${objectKey}`;
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        ResponseContentType: options?.contentType,
        ResponseContentDisposition: options?.contentDisposition,
      }),
      { expiresIn: toExpiresInSeconds(options?.expiresIn) },
    );
  }

  async getMetaData(key: string): Promise<DiskMetaData> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return {
        contentLength: res.ContentLength ?? 0,
        contentType: res.ContentType,
        etag: res.ETag,
        lastModified: res.LastModified,
      };
    } catch (err) {
      if (isNotFound(err)) throw new Error(`S3Disk: file not found: ${key}`);
      throw err;
    }
  }

  // --- Extended object operations (ExtendedDisk) --------------------------------------------

  async size(key: string): Promise<number> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return res.ContentLength ?? 0;
    } catch (err) {
      if (isNotFound(err)) throw new Error(`S3Disk: file not found: ${key}`);
      throw err;
    }
  }

  async stat(key: string): Promise<DiskStat> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(key) }),
      );
      return {
        size: res.ContentLength ?? 0,
        contentType: res.ContentType,
        lastModified: res.LastModified,
      };
    } catch (err) {
      if (isNotFound(err)) throw new Error(`S3Disk: file not found: ${key}`);
      throw err;
    }
  }

  async copy(from: string, to: string, options?: CopyOptions): Promise<void> {
    const targetBucket = options?.toBucket ?? this.bucket;
    await this.client.send(
      new CopyObjectCommand({
        // Destination bucket (may differ from the source for cross-bucket copies).
        Bucket: targetBucket,
        // Source is always this disk's configured bucket + prefixed key.
        CopySource: `${this.bucket}/${this.key(from)}`,
        Key: this.key(to),
      }),
    );
  }

  async move(from: string, to: string, options?: CopyOptions): Promise<void> {
    await this.copy(from, to, options);
    await this.delete(from);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // S3 caps a DeleteObjects batch at 1000 keys.
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((key) => ({ Key: this.key(key) })) },
        }),
      );
      // DeleteObjects returns 200 with a per-key Errors[] on partial failure; single delete()
      // throws on failure, so match that here instead of swallowing.
      if (res.Errors && res.Errors.length > 0) {
        const failed = res.Errors.map((error) => error.Key ?? '?').join(', ');
        throw new Error(`S3Disk: deleteMany failed for keys: ${failed}`);
      }
    }
  }

  async list(prefix: string, options?: ListOptions): Promise<ListResult> {
    const bucket = options?.bucket ?? this.bucket;
    const fullPrefix = this.key(prefix);
    try {
      const out = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: fullPrefix,
          Delimiter: options?.delimiter ?? '/',
          MaxKeys: options?.limit,
          ContinuationToken: options?.cursor,
        }),
      );
      const folders = (out.CommonPrefixes ?? [])
        .map((commonPrefix) => commonPrefix.Prefix)
        .filter((value): value is string => typeof value === 'string');
      const files: ListEntry[] = (out.Contents ?? [])
        .filter((object) => object.Key !== undefined && object.Key !== fullPrefix)
        .map((object) => {
          const objectKey = object.Key as string;
          return {
            key: objectKey,
            name: objectKey.slice(fullPrefix.length),
            sizeBytes: object.Size ?? null,
            lastModified: object.LastModified ?? null,
          };
        });
      const result: ListResult = { folders, files };
      if (out.IsTruncated && out.NextContinuationToken !== undefined) {
        result.cursor = out.NextContinuationToken;
      }
      return result;
    } catch (err) {
      if (!isXmlEntityDeserializationError(err)) throw err;
      // fast-xml-parser rejected valid entity refs in the ListObjectsV2 XML — presign the same
      // request and fetch the raw body, then parse it by hand into the same shape. The presigner is
      // already bundled with this disk, so the fallback adds no new dependency (see xml_fallback.ts).
      const signedUrl = await getSignedUrl(
        this.client,
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: fullPrefix,
          Delimiter: options?.delimiter ?? '/',
          MaxKeys: options?.limit,
          ContinuationToken: options?.cursor,
        }),
        { expiresIn: 60 },
      );
      const response = await fetch(signedUrl);
      if (!response.ok) {
        throw new Error(
          `S3Disk: signed list fallback failed: HTTP ${response.status} ${response.statusText}`,
        );
      }
      const xml = await response.text();
      const parsed = extractListObjectsV2FromXml(xml);
      const files: ListEntry[] = parsed.objects
        .filter((object) => object.key !== fullPrefix)
        .map((object) => ({
          key: object.key,
          name: object.key.slice(fullPrefix.length),
          sizeBytes: object.size,
          lastModified: object.lastModified ? new Date(object.lastModified) : null,
        }));
      const result: ListResult = { folders: parsed.folders, files };
      if (parsed.isTruncated && parsed.nextContinuationToken) {
        result.cursor = parsed.nextContinuationToken;
      }
      return result;
    }
  }

  // --- Native multipart (MultipartUploadDisk) -----------------------------------------------

  async createMultipartUpload(
    key: string,
    options?: DiskWriteOptions,
  ): Promise<{ uploadId: string }> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        ContentType: options?.contentType,
        ACL: options?.visibility === 'public' ? 'public-read' : undefined,
      }),
    );
    if (!out.UploadId) throw new Error('S3Disk: S3 did not return an UploadId');
    return { uploadId: out.UploadId };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<MultipartPart> {
    const out = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
      }),
    );
    if (!out.ETag) throw new Error('S3Disk: S3 did not return an ETag for the uploaded part');
    return { partNumber, etag: out.ETag };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: Math.max(1, Math.round(expiresInSeconds)) },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .slice()
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key(key),
        UploadId: uploadId,
      }),
    );
  }
}
