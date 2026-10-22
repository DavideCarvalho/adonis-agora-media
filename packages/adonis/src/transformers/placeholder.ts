import { TransformerRuntimeMissingError } from '../errors.js';
import type { MediaRecord } from '../media_record.js';
import type { Transformer, TransformerContext, TransformResult } from '../transformer.js';

/** What a placeholder run yields — persisted verbatim as the conversion's `meta`. */
export interface ImagePlaceholder {
  /**
   * A tiny (≤ `size` px on the long edge) WebP of the image, as a `data:` URL — typically a few
   * hundred bytes. Inline it as the `<img>` background (or `src`) and blur it with CSS while the
   * real image loads; no client-side decoder needed.
   */
  dataUrl: string;
  /** Width of the original, after EXIF orientation. Use it with {@link height} to reserve layout. */
  width: number;
  /** Height of the original, after EXIF orientation. */
  height: number;
  /** Dominant colour as `#rrggbb` — a flat fallback for the placeholder. */
  color: string;
}

export interface PlaceholderOptions {
  /** Long edge of the tiny preview, in px. Default `16`. */
  size: number;
  /** WebP quality of the tiny preview. Default `50`. */
  quality: number;
}

/**
 * The engine seam of {@link PlaceholderTransformer}: image bytes in, placeholder out. The default
 * engine is sharp (lazy); tests inject a fake.
 */
export interface PlaceholderEngine {
  generate(input: Uint8Array, options: PlaceholderOptions): Promise<ImagePlaceholder>;
}

export interface PlaceholderTransformerOptions<Name extends string = 'placeholder'> {
  /** Conversion name on the record. Default `'placeholder'`. */
  name?: Name;
  /**
   * Run inside attach. Default `true`: a placeholder is only useful if it exists by the time the
   * image is first rendered, and generating one is a single small decode. It does read the whole
   * original, though — on a remote disk (S3) that is a download per attach; set `false` and run
   * `media.library.transform(id, name)` from a job if that matters more than having it at once.
   */
  eager?: boolean;
  /** Long edge of the tiny preview, in px. Default `16` — bigger is sharper but heavier inline. */
  size?: number;
  /** WebP quality of the tiny preview (1–100). Default `50`. */
  quality?: number;
  /** Replace the sharp engine (mainly for tests). */
  engine?: PlaceholderEngine;
}

/**
 * The built-in **image placeholder** {@link Transformer} — a metadata-only transform: it writes no
 * artifact, and persists on `record.conversions['placeholder'].meta` a tiny inline preview
 * (`dataUrl`), the original's dimensions and its dominant colour. Everything a page needs to
 * render a blurred LQIP with the right aspect ratio before the real image arrives, without a
 * second request.
 *
 * ```ts
 * // config/media.ts
 * { name: 'avatar', acceptsMimeTypes: ['image/png', 'image/jpeg'], transformers: [transformers.placeholder()] }
 *
 * const record = await media.library.find(id)
 * record.conversions.placeholder?.meta // { dataUrl: 'data:image/webp;base64,…', width, height, color }
 * ```
 *
 * Eager by default. A record whose MIME type is not `image/*`, or is an SVG, is skipped (`meta: {}`) rather than
 * failing the attach, so declaring it on a mixed collection (images + PDFs) is safe.
 */
export class PlaceholderTransformer<Name extends string = 'placeholder'> implements Transformer {
  readonly name: Name;
  readonly eager: boolean;
  private readonly options: PlaceholderOptions;
  private readonly engine: PlaceholderEngine | undefined;

  constructor(options: PlaceholderTransformerOptions<Name> = {}) {
    this.name = options.name ?? ('placeholder' as Name);
    this.eager = options.eager ?? true;
    this.options = { size: options.size ?? 16, quality: options.quality ?? 50 };
    this.engine = options.engine;
  }

  async transform(context: TransformerContext): Promise<TransformResult> {
    // Vectors are skipped too: they render crisp at any size (nothing to blur up to), and an SVG
    // without intrinsic dimensions makes sharp throw — which, eager, would roll back the attach.
    const { mimeType } = context.record;
    if (!mimeType.startsWith('image/') || mimeType.startsWith('image/svg')) return { meta: {} };
    const engine = this.engine ?? (await loadSharpPlaceholderEngine(this.name));
    const placeholder = await engine.generate(await context.getBytes(), this.options);
    return { meta: { ...placeholder } };
  }
}

/**
 * Read the blur-up placeholder off a record: the first conversion whose `meta` has the
 * {@link ImagePlaceholder} shape, so a renamed transformer (`name: 'lqip'`) is found too. `null`
 * when the collection has no placeholder transformer, it hasn't run, or it skipped a non-image.
 *
 * ```ts
 * const record = await media.library.find(user.avatarMediaId)
 * return { avatarUrl, avatarPlaceholder: record && placeholderOf(record) }
 * ```
 */
export function placeholderOf(record: MediaRecord): ImagePlaceholder | null {
  for (const conversion of Object.values(record.conversions)) {
    const meta = conversion.meta;
    if (
      meta &&
      typeof meta.dataUrl === 'string' &&
      typeof meta.color === 'string' &&
      Number.isFinite(meta.width) &&
      Number.isFinite(meta.height)
    ) {
      return {
        dataUrl: meta.dataUrl,
        width: meta.width as number,
        height: meta.height as number,
        color: meta.color,
      };
    }
  }
  return null;
}

/**
 * sharp-backed {@link PlaceholderEngine}, importing the optional peer on first use.
 *
 * @internal `importSharp` is the seam tests use to simulate a host without the peer.
 */
export async function loadSharpPlaceholderEngine(
  transformerName: string,
  importSharp: () => Promise<{ default: typeof import('sharp').default }> = () => import('sharp'),
): Promise<PlaceholderEngine> {
  let sharp: typeof import('sharp').default;
  try {
    sharp = (await importSharp()).default;
  } catch (error) {
    // Only a missing `sharp` itself — a broken install missing a transitive dep must surface as is.
    if (
      (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' &&
      error instanceof Error &&
      error.message.includes("'sharp'")
    ) {
      throw new TransformerRuntimeMissingError(
        transformerName,
        "the optional peer dependency 'sharp'",
        'Install it (`pnpm add sharp`) or inject a custom `engine`.',
      );
    }
    throw error;
  }

  return {
    async generate(input, { size, quality }) {
      const image = sharp(input, { failOn: 'none' }).rotate();
      const metadata = await image.metadata();
      // `metadata()` reports the stored (pre-rotation) size; orientations 5–8 swap the axes.
      const swap = (metadata.orientation ?? 1) >= 5;
      const width = (swap ? metadata.height : metadata.width) ?? 0;
      const height = (swap ? metadata.width : metadata.height) ?? 0;

      const [{ dominant }, tiny] = await Promise.all([
        image.clone().stats(),
        image
          .clone()
          .resize(size, size, { fit: 'inside' })
          .webp({ quality, alphaQuality: quality })
          .toBuffer(),
      ]);

      return {
        dataUrl: `data:image/webp;base64,${tiny.toString('base64')}`,
        width,
        height,
        color: `#${[dominant.r, dominant.g, dominant.b].map((c) => c.toString(16).padStart(2, '0')).join('')}`,
      };
    },
  };
}
