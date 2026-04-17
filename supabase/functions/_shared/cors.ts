// Shared CORS headers for every Marketify edge function.
//
// Contract: exports `corsHeaders` (Record<string, string>) to splat into
//           every edge function's response and a pre-flight short-circuit.
// Auth:     n/a — the browser reads these before the request runs.
//
// `*` origin is safe here: edge functions authenticate via the
// Authorization: Bearer <marketify_jwt> header, not cookies, so there is no
// ambient-credential risk to guard against with a narrower origin allowlist.

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
