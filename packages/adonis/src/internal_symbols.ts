/**
 * Symbol-keyed entry points `MediaAccess` uses to hand `MediaLibrary` a record it has ALREADY
 * fetched (and authorized), instead of the id — which would make the library look it up again.
 * Not re-exported from the package entry: an internal seam, not public API.
 *
 * @internal
 */
export const imageOfRecord: unique symbol = Symbol('@adonis-agora/media:imageOfRecord');
/** @internal */
export const streamOfRecord: unique symbol = Symbol('@adonis-agora/media:streamOfRecord');
/** @internal */
export const deliverRecord: unique symbol = Symbol('@adonis-agora/media:deliverRecord');
