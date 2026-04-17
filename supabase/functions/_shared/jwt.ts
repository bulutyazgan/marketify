// Custom JWT helper for Marketify edge functions.
//
// Contract: signJwt({ sub, role, session_id }, { ttlSeconds? }) -> compact JWT.
//           verifyJwt(token) -> parsed claims or throws.
// Algorithm: HS256 (HMAC-SHA256) via Web Crypto.
// Secret: MARKETIFY_JWT_SECRET env var — this is OUR signing key, deliberately
//         separate from Supabase's built-in JWT secret. Every `/auth/*` edge
//         function mints tokens here; RLS policies read `sub` and `role` via
//         `auth.jwt()`. `session_id` feeds the denylist lookup in §15c.
// Auth:   no inbound auth requirement — this module is a building block.

export type UserRole = "creator" | "lister";

export interface JwtClaims {
  sub: string;
  role: UserRole;
  session_id: string;
  iat: number;
  exp: number;
}

export interface SignInput {
  sub: string;
  role: UserRole;
  session_id: string;
}

export interface SignOptions {
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function readSecret(): string {
  const s = Deno.env.get("MARKETIFY_JWT_SECRET");
  if (!s) throw new Error("MARKETIFY_JWT_SECRET is not set");
  return s;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const rem = input.length % 4;
  const b64 = (rem === 0 ? input : input + "=".repeat(4 - rem))
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  let raw: string;
  try {
    raw = atob(b64);
  } catch {
    throw new Error("Malformed JWT");
  }
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function importKey(
  secret: string,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function signJwt(
  input: SignInput,
  options: SignOptions = {},
): Promise<string> {
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("ttlSeconds must be a positive finite number");
  }
  if (input.role !== "creator" && input.role !== "lister") {
    throw new Error("role must be 'creator' or 'lister'");
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: JwtClaims = {
    sub: input.sub,
    role: input.role,
    session_id: input.session_id,
    iat: now,
    exp: now + ttl,
  };

  const headerB64 = base64UrlEncode(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(readSecret(), ["sign"]);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(signingInput),
  );
  const sigB64 = base64UrlEncode(new Uint8Array(sig));

  return `${signingInput}.${sigB64}`;
}

export async function verifyJwt(token: string): Promise<JwtClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string };
  try {
    header = JSON.parse(decoder.decode(base64UrlDecode(headerB64)));
  } catch {
    throw new Error("Malformed JWT");
  }
  if (header.alg !== "HS256") throw new Error("Unsupported JWT algorithm");

  const key = await importKey(readSecret(), ["verify"]);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlDecode(sigB64),
    encoder.encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error("Bad signature");

  let payload: Partial<JwtClaims>;
  try {
    payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64)));
  } catch {
    throw new Error("Malformed JWT");
  }

  if (
    typeof payload.sub !== "string" || payload.sub.length === 0 ||
    (payload.role !== "creator" && payload.role !== "lister") ||
    typeof payload.session_id !== "string" ||
    payload.session_id.length === 0 ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number"
  ) {
    throw new Error("JWT missing required claims");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("JWT expired");
  if (payload.iat > now + 60) throw new Error("JWT iat in the future");

  return payload as JwtClaims;
}
