// Client-side URL classifier + TikTok oEmbed fetch, used by the
// submission composer (US-046) to render a live preview card before
// the creator taps Submit.
//
// Mirrors the server-side helper at `supabase/functions/_shared/oembed.ts`
// so client validation gives the same platform/external_id answer the
// submit-video edge function will reach. The server remains the source
// of truth — a green client-side preview is NOT a submission guarantee;
// the edge function re-classifies + re-fetches before persisting.
//
// Instagram: classification-only. The Meta Graph instagram_oembed
// endpoint requires an app-level token we don't provision in the
// client (and don't want to — it'd ship with the JS bundle). IG URLs
// render a platform-label preview card; server-side submission is
// still regex-shape only per docs/tech-architecture.md §3h.

export type OembedPlatform = 'tiktok' | 'instagram';

export interface UrlClassification {
  platform: OembedPlatform;
  externalId: string | null;
}

export interface TikTokOembedPreview {
  thumbnailUrl: string | null;
  authorHandle: string | null;
  title: string | null;
  raw: Record<string, unknown>;
}

const TIKTOK_CANONICAL_RE =
  /^https:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._-]+\/video\/(\d+)/i;
const TIKTOK_SHORTLINK_RE =
  /^https:\/\/(?:vm|vt)\.tiktok\.com\/[A-Za-z0-9]+\/?/i;
const TIKTOK_TLINK_RE =
  /^https:\/\/(?:www\.)?tiktok\.com\/t\/[A-Za-z0-9]+\/?/i;

const INSTAGRAM_RE =
  /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?/i;

export function classifyVideoUrl(url: string): UrlClassification | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  const canon = trimmed.match(TIKTOK_CANONICAL_RE);
  if (canon) {
    return { platform: 'tiktok', externalId: canon[1] };
  }
  if (TIKTOK_SHORTLINK_RE.test(trimmed) || TIKTOK_TLINK_RE.test(trimmed)) {
    return { platform: 'tiktok', externalId: null };
  }
  const ig = trimmed.match(INSTAGRAM_RE);
  if (ig) {
    return { platform: 'instagram', externalId: ig[1] };
  }
  return null;
}

export async function fetchTikTokOembed(
  url: string,
  signal?: AbortSignal,
): Promise<TikTokOembedPreview | null> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { signal });
  if (response.status === 404 || response.status === 400) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`TikTok oEmbed HTTP ${response.status}`);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const thumbnailUrl = typeof data.thumbnail_url === 'string'
    ? data.thumbnail_url
    : null;
  const authorHandle = extractTikTokAuthorHandle(data);
  const title = typeof data.title === 'string' && data.title.trim().length > 0
    ? data.title.trim()
    : null;
  return { thumbnailUrl, authorHandle, title, raw: data };
}

function extractTikTokAuthorHandle(
  data: Record<string, unknown>,
): string | null {
  const candidates = [data.author_unique_id, data.author_name];
  for (const raw of candidates) {
    if (typeof raw === 'string') {
      const h = raw.trim().replace(/^@+/, '');
      if (h.length > 0) return h;
    }
  }
  return null;
}
