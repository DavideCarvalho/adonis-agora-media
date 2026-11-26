/**
 * What may go into a response header. Node refuses a header value with a control character or a
 * character outside latin-1 (`ERR_INVALID_CHAR`) when the response is written, long after the
 * handler returned: an unhandled rejection that takes the process down. Anything that reaches a
 * header from a request, a stored record or a disk goes through here first.
 */

/** RFC 6838 `restricted-name`: what a MIME type's `type` and `subtype` are made of. */
const RESTRICTED_NAME = '[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}';
const MIME_TYPE = new RegExp(`^${RESTRICTED_NAME}/${RESTRICTED_NAME}$`);
/** Visible ASCII and spaces: always a valid header value. */
const HEADER_SAFE = /^[\x20-\x7e]*$/;

/** Whether `value` is a bare `type/subtype` MIME type (no parameters), e.g. `image/png`. */
export function isMimeType(value: unknown): value is string {
  return typeof value === 'string' && MIME_TYPE.test(value);
}

/**
 * A `Content-Type` safe to send: `value` when its `type/subtype` is well formed and the whole value
 * (parameters included) is visible ASCII, else `fallback`.
 */
export function safeContentType(
  value: string | undefined | null,
  fallback = 'application/octet-stream',
): string {
  if (typeof value !== 'string' || !HEADER_SAFE.test(value)) return fallback;
  const base = value.split(';')[0]!.trim();
  return isMimeType(base) ? value : fallback;
}

/** Whether `value` can go into a header as it is. */
export function isHeaderSafe(value: string): boolean {
  return HEADER_SAFE.test(value);
}
