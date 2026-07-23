import { createHash, createHmac } from 'node:crypto';

/**
 * Static credentials a SigV4 signature is computed from. Mirrors the resolved shape of an AWS
 * credential provider (`accessKeyId`/`secretAccessKey` + the optional STS `sessionToken`).
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

/**
 * Input for {@link presignS3Url}. `host` + `path` are given separately (never a pre-built URL)
 * because the signature covers both and they must be byte-identical between what is signed and what
 * the client requests: the presigner encodes the raw `path` exactly once and uses that single
 * encoding for the canonical request AND the returned URL, so the two cannot drift.
 */
export interface PresignS3UrlInput {
  /** HTTP method the URL authorizes (`GET`, `PUT`, …). */
  method: string;
  /** URL scheme of the endpoint. */
  protocol: 'http:' | 'https:';
  /** Host the client will connect to, including a non-default port (`minio.example.com:9000`). */
  host: string;
  /** Absolute, UNENCODED object path (`/bucket/my key.png`). Encoded here, exactly once. */
  path: string;
  /** Extra query parameters to sign into the URL (`uploadId`, `partNumber`, `response-content-type`, …). */
  query?: Record<string, string> | undefined;
  credentials: SigV4Credentials;
  /** Signing region — must match what the endpoint expects (`us-east-1` for MinIO defaults). */
  region: string;
  /** Signing service. Default `s3`. */
  service?: string | undefined;
  /** Lifetime of the URL, in whole seconds (SigV4 caps this at 7 days / 604800). */
  expiresInSeconds: number;
  /** Signing time. Injectable so tests can pin the signature; defaults to `new Date()`. */
  now?: Date | undefined;
}

/**
 * RFC 3986 percent-encoding as SigV4 defines it: everything except unreserved characters
 * (`A–Z a–z 0–9 - _ . ~`) is encoded, with uppercase hex. `encodeURIComponent` is close but leaves
 * `!'()*` bare, and any of those in an object key would make the canonical request disagree with
 * what S3 reconstructs server-side — a signature mismatch that only bites on the one file whose
 * name contains them.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode a path for the canonical URI: each segment percent-encoded, `/` separators preserved. */
function encodePath(path: string): string {
  return path.split('/').map(uriEncode).join('/');
}

/** `YYYYMMDD'T'HHMMSS'Z'` — the `X-Amz-Date` format. */
function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Presign an S3 request with AWS Signature Version 4 **query-string authentication** — the
 * credential, timestamp, TTL and signature all travel as `X-Amz-*` query parameters, so the URL is
 * self-contained and anyone holding it (a browser `PUT`ting a multipart part, a `<video>` tag
 * streaming a segment) can perform exactly this one request until it expires.
 *
 * Hand-rolled on `node:crypto` — ~60 lines of HMAC chaining — instead of pulling in
 * `@aws-sdk/s3-request-presigner`: presigning is pure computation (no round-trip to S3), and owning
 * it lets the signature target ANY host. That is what makes a split internal/public endpoint
 * trivial: SigV4 signs the `Host` header, so a URL signed for the internal endpoint is invalid on
 * the public one — with the SDK that means constructing a second client per endpoint, here it is
 * just a different `host` argument.
 *
 * The payload is declared `UNSIGNED-PAYLOAD`, the standard for presigned S3 URLs: the body cannot
 * be known at signing time (the client hasn't produced it yet), and S3 accepts the literal in the
 * canonical request for query-auth.
 *
 * Verified against AWS's published SigV4 test vector (the documented `examplebucket` presigned GET)
 * in `test/sigv4.spec.ts`.
 */
export function presignS3Url(input: PresignS3UrlInput): string {
  const service = input.service ?? 's3';
  const now = input.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;

  const query: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(Math.max(1, Math.round(input.expiresInSeconds))),
    'X-Amz-SignedHeaders': 'host',
    ...(input.credentials.sessionToken !== undefined
      ? { 'X-Amz-Security-Token': input.credentials.sessionToken }
      : {}),
  };

  // Canonical query string: pairs encoded first, then sorted BY THE ENCODED bytes — the order S3
  // reconstructs on its side.
  const canonicalQuery = Object.entries(query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');

  const canonicalPath = encodePath(input.path);
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    `host:${input.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${input.protocol}//${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
