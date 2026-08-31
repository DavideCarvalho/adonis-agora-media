import type { Transformer, TransformerContext, TransformResult } from '../transformer.js';

export interface FakeTransformerOptions<Name extends string = string> {
  /** Conversion name this fake produces. */
  name: Name;
  eager?: boolean;
  /** Artifacts to write through `context.write`, keyed by prefix-relative path. */
  artifacts?: Record<string, string>;
  /**
   * Entry declared in the result. Defaults to the first artifact key; pass `null` for a
   * metadata-only result (with no artifacts).
   */
  entry?: string | null;
  /** Metadata declared in the result. */
  meta?: Record<string, unknown>;
  /** Full behavior override — everything above but `name`/`eager` is ignored when set. */
  behavior?: (context: TransformerContext) => Promise<TransformResult>;
}

/**
 * Deterministic {@link Transformer} for tests — the transformer counterpart of
 * `FakeImageProcessor`. It records every context it is called with and writes/declares exactly
 * what it was configured to, so eager/deferred behaviour, artifact bookkeeping and rollback can be
 * asserted without a media engine.
 */
export class FakeTransformer<Name extends string = string> implements Transformer {
  readonly name: Name;
  readonly eager: boolean;
  readonly calls: TransformerContext[] = [];
  private readonly options: FakeTransformerOptions<Name>;

  constructor(options: FakeTransformerOptions<Name>) {
    this.name = options.name;
    this.eager = options.eager ?? false;
    this.options = options;
  }

  async transform(context: TransformerContext): Promise<TransformResult> {
    this.calls.push(context);
    if (this.options.behavior) return this.options.behavior(context);

    const artifacts = Object.entries(this.options.artifacts ?? {});
    for (const [path, content] of artifacts) {
      await context.write(path, Buffer.from(content, 'utf8'));
    }

    const entry =
      this.options.entry === null ? undefined : (this.options.entry ?? artifacts[0]?.[0]);
    return {
      ...(entry !== undefined ? { entry } : {}),
      ...(this.options.meta !== undefined ? { meta: this.options.meta } : {}),
    };
  }
}
