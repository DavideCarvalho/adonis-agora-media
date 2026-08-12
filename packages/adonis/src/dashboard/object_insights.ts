/**
 * Host-supplied context about a disk object, shown in the console's preview.
 *
 * Ported from the NestJS sibling console's `server/object-insights.ts`. The console can describe a
 * file only as storage sees it: key, size, content type, last modified. Everything that makes the
 * file *mean* something lives in the host — which work order this scan belongs to, which knowledge
 * base indexed it. This is the seam for handing that back: the host registers a provider (via
 * `config/media_dashboard.ts`'s `objectInsights`), the console asks it when an object is previewed
 * and renders whatever comes back.
 *
 * **Data, not components** — same reason as the NestJS side: the console ships as a prebuilt SPA
 * bundle, so a host cannot inject React into it. A provider returns a small structured value the
 * console knows how to render (facts, links, a note).
 */

import type { ObjectInsight, ObjectInsightsResponse } from './types.js';

export type {
  ObjectInsight,
  ObjectInsightFact,
  ObjectInsightLink,
  ObjectInsightsResponse,
} from './types.js';

/** Which object is being described. */
export interface ObjectInsightContext {
  disk: string;
  key: string;
}

/**
 * A source of {@link ObjectInsight}s, registered by the host in `config/media_dashboard.ts`.
 *
 * `resolve` runs on every preview of every object, so it must be cheap. Return `null` for an object
 * this provider has nothing to say about, and the console renders nothing for it. A provider that
 * throws is skipped (logged by the caller) — annotation must never be able to stop an admin opening
 * a file.
 */
export interface ObjectInsightProvider {
  /** Stable identifier, used in the log line when this provider fails. */
  id: string;
  resolve(ctx: ObjectInsightContext): Promise<ObjectInsight | null> | ObjectInsight | null;
}

/** Schemes an {@link ObjectInsightLink} may point at. Anything else is dropped, not rendered. */
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:']);

/**
 * Drop links the console must not render. A relative href (`/ctrl/...`) always addresses the host's
 * own app and is kept; an absolute one is kept only if it is http(s) (refuses `javascript:`/`data:`).
 */
export function sanitizeInsight(insight: ObjectInsight): ObjectInsight {
  if (insight.links === undefined) return insight;
  const links = insight.links.filter((link) => {
    if (link.href.startsWith('/')) {
      // `//evil.com` is protocol-relative — an absolute URL wearing a relative one's clothes.
      return !link.href.startsWith('//');
    }
    try {
      return SAFE_LINK_SCHEMES.has(new URL(link.href).protocol);
    } catch {
      return false;
    }
  });
  return { ...insight, links };
}

/** `{ insights: [] }` — what the console renders when no providers are registered. */
export function emptyInsights(): ObjectInsightsResponse {
  return { insights: [] };
}
