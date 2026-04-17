// URL classification + oEmbed fetch for TikTok / Instagram post URLs.
//
// Consumers: submit-video (US-045). Extend here before adding platforms.
//
// Platform detection is based on URL host + path shape — we accept the
// common formats a creator is likely to paste:
//   TikTok:    https://www.tiktok.com/@handle/video/1234567890
//              https://vm.tiktok.com/XXXXXXX/      (share redirect)
//              https://vt.tiktok.com/XXXXXXX/      (share redirect)
//              https://www.tiktok.com/t/XXXXXXX/   (share redirect)
//   Instagram: https://www.instagram.com/p/<code>/
//              https://www.instagram.com/reel/<code>/
//              https://www.instagram.com/tv/<code>/
//
// external_id extraction is best-effort. For canonical TikTok URLs the
// trailing numeric video id is the external_id; for shortlinks we leave
// external_id null and let the oEmbed response (if available) provide it
// via provider-specific fields (currently unused). The
// `submission_reuse_view` in public skips rows with external_id IS NULL,
// so shortlink-only rows simply don't participate in reuse counting until
// the lister paste-flow hands us a canonical URL.
//
// oEmbed endpoints (docs/tech-architecture.md §3h):
//   TikTok:    GET https://www.tiktok.com/oembed?url=<share_url>      (no auth)
//   Instagram: GET https://graph.facebook.com/v<ver>/instagram_oembed (app-token)
//
// Instagram oEmbed requires an app-level Meta token. We do NOT have one
// configured, so IG validation here is regex-shape only; the spec §3h
// notes this requirement. Expand `fetchOembed` once the token is wired.

export type OembedPlatform = "tiktok" | "instagram";

export interface UrlClassification {
  platform: OembedPlatform;
  externalId: string | null;
}

export interface OembedResult {
  thumbnailUrl: string | null;
  authorHandle: string | null;
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
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  const canon = trimmed.match(TIKTOK_CANONICAL_RE);
  if (canon) {
    return { platform: "tiktok", externalId: canon[1] };
  }
  if (TIKTOK_SHORTLINK_RE.test(trimmed) || TIKTOK_TLINK_RE.test(trimmed)) {
    return { platform: "tiktok", externalId: null };
  }
  const ig = trimmed.match(INSTAGRAM_RE);
  if (ig) {
    return { platform: "instagram", externalId: ig[1] };
  }
  return null;
}

export async function fetchTikTokOembed(
  url: string,
): Promise<OembedResult | null> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { "User-Agent": "marketify-submit-video/1.0" },
    });
  } catch (_err) {
    // Network failures are treated as "URL could not be validated" at the
    // caller's discretion. Throw fixed-string errors rather than ${err}
    // to avoid leaking internal paths if fetch implementations ever grow
    // diagnostic info.
    throw new Error("TikTok oEmbed fetch failed");
  }
  if (response.status === 404 || response.status === 400) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`TikTok oEmbed HTTP ${response.status}`);
  }
  let data: Record<string, unknown>;
  try {
    data = await response.json();
  } catch {
    throw new Error("TikTok oEmbed returned non-JSON");
  }
  const thumbnailUrl = typeof data.thumbnail_url === "string"
    ? data.thumbnail_url
    : null;
  const authorHandle = extractTikTokAuthorHandle(data);
  return { thumbnailUrl, authorHandle, raw: data };
}

function extractTikTokAuthorHandle(
  data: Record<string, unknown>,
): string | null {
  // TikTok's oEmbed returns `author_unique_id` (canonical handle) and
  // `author_name` (display name). Prefer the unique id; strip any leading
  // @ because our social_links.handle is stored without it.
  const candidates = [data.author_unique_id, data.author_name];
  for (const raw of candidates) {
    if (typeof raw === "string") {
      const h = raw.trim().replace(/^@+/, "");
      if (h.length > 0) return h;
    }
  }
  return null;
}
