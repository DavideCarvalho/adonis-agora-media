/**
 * The AWS SDK deserializes S3's XML responses with `fast-xml-parser`. Some hosts pin
 * `fast-xml-parser` v5 (CVE remediation), whose stricter mode rejects valid numeric character
 * references (`&#xD;`, …) that S3 legitimately emits inside keys — surfacing as a deserialization
 * error on `ListObjectsV2`. This module provides a fallback for {@link S3Disk.list}: re-issue the
 * request as a signed raw GET (presigned with `@aws-sdk/s3-request-presigner`, an existing optional
 * peer) and hand-parse the XML, bypassing `fast-xml-parser` entirely.
 *
 * NOTE: this fallback does NOT depend on `fast-xml-parser` — it exists precisely to work around it —
 * and introduces NO new peer: the signing reuses the presigner already bundled with the S3 disk, so
 * only regex XML parsing lives here.
 */

const ENTITY_NAME_REGEX = /Invalid character.*entity name/i;

/** Is this the `fast-xml-parser` entity-rejection error the signed-GET fallback exists for? */
export function isXmlEntityDeserializationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message ?? '';
  return (
    message.includes('EntityReplacer') ||
    message.includes('Deserialization') ||
    ENTITY_NAME_REGEX.test(message)
  );
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9A-Fa-f]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export interface ListObjectsV2Entry {
  key: string;
  size: number | null;
  lastModified: string | null;
}

export interface ListObjectsV2FromXml {
  folders: string[];
  objects: ListObjectsV2Entry[];
  nextContinuationToken: string | null;
  isTruncated: boolean;
}

/** Hand-parse a `ListObjectsV2` XML body into the shape {@link S3Disk.list} needs. */
export function extractListObjectsV2FromXml(xml: string): ListObjectsV2FromXml {
  const folders = matchAll(
    xml,
    /<CommonPrefixes>[\s\S]*?<Prefix>([\s\S]*?)<\/Prefix>[\s\S]*?<\/CommonPrefixes>/g,
  ).map((match) => decodeXmlEntities(match[1] ?? ''));

  const objects: ListObjectsV2Entry[] = matchAll(xml, /<Contents>([\s\S]*?)<\/Contents>/g).map(
    (match) => {
      const block = match[1] ?? '';
      const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
      const sizeMatch = block.match(/<Size>([\s\S]*?)<\/Size>/);
      const lastModifiedMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
      return {
        key: keyMatch ? decodeXmlEntities(keyMatch[1] ?? '') : '',
        size: sizeMatch ? Number(sizeMatch[1]) : null,
        lastModified: lastModifiedMatch ? decodeXmlEntities(lastModifiedMatch[1] ?? '') : null,
      };
    },
  );

  const nextContinuationTokenMatch = xml.match(
    /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/,
  );
  const isTruncatedMatch = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/);

  return {
    folders,
    objects,
    nextContinuationToken: nextContinuationTokenMatch
      ? decodeXmlEntities(nextContinuationTokenMatch[1] ?? '')
      : null,
    isTruncated: isTruncatedMatch?.[1] === 'true',
  };
}

function matchAll(input: string, regex: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  const localRegex = new RegExp(regex.source, regex.flags);
  let match: RegExpExecArray | null = localRegex.exec(input);
  while (match !== null) {
    matches.push(match);
    match = localRegex.exec(input);
  }
  return matches;
}
