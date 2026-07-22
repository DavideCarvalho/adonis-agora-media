import { describe, expect, it } from 'vitest';
import { presignS3Url } from '../src/disks/sigv4.js';

/**
 * The credentials from AWS's own SigV4 documentation examples ("Authenticating Requests: Using
 * Query Parameters"). Everything about the first test is fixed by that document — inputs AND the
 * expected signature — so it proves the whole chain (canonical request → string-to-sign → key
 * derivation → signature) against an authority outside this codebase, not against itself.
 */
const AWS_DOC_CREDENTIALS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

const AWS_DOC_DATE = new Date('2013-05-24T00:00:00Z');

describe('presignS3Url — SigV4 query-string authentication', () => {
  it('reproduces the AWS documentation test vector byte for byte', () => {
    const url = presignS3Url({
      method: 'GET',
      protocol: 'https:',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      credentials: AWS_DOC_CREDENTIALS,
      region: 'us-east-1',
      expiresInSeconds: 86400,
      now: AWS_DOC_DATE,
    });

    // The full URL AWS documents for this request, including the known-good signature.
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z' +
        '&X-Amz-Expires=86400' +
        '&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('locks the presigned multipart part-PUT shape (regression vector)', () => {
    // No official AWS vector exists for UploadPart, so this pins our own known-good output: any
    // change to encoding, ordering or key derivation shows up as a diff here.
    const url = presignS3Url({
      method: 'PUT',
      protocol: 'http:',
      host: 'minio.internal:9000',
      path: '/videos/uploads/abc/original.mp4',
      query: { uploadId: 'mp-1', partNumber: '7' },
      credentials: AWS_DOC_CREDENTIALS,
      region: 'us-east-1',
      expiresInSeconds: 3600,
      now: AWS_DOC_DATE,
    });

    expect(url).toBe(
      [
        'http://minio.internal:9000/videos/uploads/abc/original.mp4',
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256',
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request',
        '&X-Amz-Date=20130524T000000Z',
        '&X-Amz-Expires=3600',
        '&X-Amz-SignedHeaders=host',
        '&partNumber=7',
        '&uploadId=mp-1',
        `&X-Amz-Signature=${expectedPartSignature}`,
      ].join(''),
    );
  });

  it('includes and signs the STS session token when present', () => {
    const url = presignS3Url({
      method: 'GET',
      protocol: 'https:',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      credentials: { ...AWS_DOC_CREDENTIALS, sessionToken: 'the-token' },
      region: 'us-east-1',
      expiresInSeconds: 86400,
      now: AWS_DOC_DATE,
    });

    expect(url).toContain('X-Amz-Security-Token=the-token');
    // The token participates in the signature: it must differ from the token-less vector's.
    expect(url).not.toContain('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('strictly RFC 3986-encodes path segments, including the characters encodeURIComponent skips', () => {
    const url = presignS3Url({
      method: 'GET',
      protocol: 'https:',
      host: 'b.s3.amazonaws.com',
      path: "/dir/my file (1)'*!.png",
      credentials: AWS_DOC_CREDENTIALS,
      region: 'us-east-1',
      expiresInSeconds: 60,
      now: AWS_DOC_DATE,
    });

    expect(url).toContain('/dir/my%20file%20%281%29%27%2A%21.png?');
  });

  it('sorts query parameters by encoded name, mixing X-Amz-* with request parameters', () => {
    const url = presignS3Url({
      method: 'PUT',
      protocol: 'https:',
      host: 'b.s3.amazonaws.com',
      path: '/k',
      query: { uploadId: 'u', partNumber: '2' },
      credentials: AWS_DOC_CREDENTIALS,
      region: 'us-east-1',
      expiresInSeconds: 60,
      now: AWS_DOC_DATE,
    });

    const names = new URL(url).search
      .slice(1)
      .split('&')
      .map((pair) => pair.split('=')[0]);
    // ASCII order: uppercase X-Amz-* first, then partNumber, then uploadId — with the signature
    // appended last, outside the sort, exactly as the spec requires.
    expect(names).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-SignedHeaders',
      'partNumber',
      'uploadId',
      'X-Amz-Signature',
    ]);
  });
});

/**
 * Independently recomputed from first principles (canonical request → string-to-sign → HMAC chain,
 * in a standalone script that does not import this module) and locked here so the suite fails on
 * ANY behavioural change to encoding, ordering or key derivation.
 */
const expectedPartSignature = '8794ae681900acdb738af495768cee54e448df77dd664a0b4bef1f9697c2b65e';
