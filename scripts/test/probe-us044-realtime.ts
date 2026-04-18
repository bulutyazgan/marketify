// US-044 end-to-end probe: verifies that the Supabase Realtime subscription
// on `public.applications` filtered by `creator_id=eq.<me>` delivers UPDATE
// events under a real Marketify JWT (HS256, `app_role=creator`).
//
// Why this exists: the in-app DevRolePicker session mints a literal
// `dev-creator-token` string that the Realtime broker rejects — so the UI
// can't actually exercise the subscription end-to-end without a signed up
// creator. Per Codebase Pattern #122, this probe closes the loop: empty-
// state screenshots from the DevRolePicker session verify the subscription
// wiring doesn't crash the screen, and this script verifies the broker
// delivers UPDATE events through `supabase.realtime.setAuth` under the
// same RLS policy (`applications_creator_rw`, polcmd='*') that guards the
// in-app stream.
//
// Run modes (argv[2]):
//
//   signup       Sign up a fresh probe creator via auth-signup-creator.
//                Prints `{user_id, token}` JSON on stdout for the operator
//                to capture. NOTE — the printed JWT has the default
//                edge-function TTL (~7 days); the operator is expected to
//                delete the probe user + its cascading rows via MCP
//                execute_sql immediately after the verify phase finishes.
//
//   subscribe    Subscribe to realtime UPDATE events on `applications`
//                filtered by `creator_id=eq.<MARKETIFY_PROBE_USER_ID>`.
//                Prints "READY <user_id>" once the channel is SUBSCRIBED
//                so the operator can seed + flip an application via
//                execute_sql, then waits up to 60s for an UPDATE event
//                whose id matches MARKETIFY_PROBE_APP_ID and asserts the
//                new.status equals MARKETIFY_PROBE_EXPECTED_STATUS
//                (default 'approved'). Exit 0 on match, 2 on timeout or
//                mismatch.
//
// Env vars required for `subscribe` mode:
//   MARKETIFY_PROBE_JWT
//   MARKETIFY_PROBE_USER_ID
//   MARKETIFY_PROBE_APP_ID
//   MARKETIFY_PROBE_EXPECTED_STATUS (optional — default 'approved')
//
// Usage:
//   bun run scripts/test/probe-us044-realtime.ts signup
//   MARKETIFY_PROBE_JWT=... MARKETIFY_PROBE_USER_ID=... \
//     MARKETIFY_PROBE_APP_ID=... \
//     bun run scripts/test/probe-us044-realtime.ts subscribe

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required in .env');
  process.exit(1);
}

const mode = process.argv[2];
if (mode !== 'signup' && mode !== 'subscribe') {
  console.error(
    'usage: bun run scripts/test/probe-us044-realtime.ts <signup|subscribe>',
  );
  process.exit(1);
}

if (mode === 'signup') {
  const unique = Date.now();
  const res = await fetch(`${supabaseUrl}/functions/v1/auth-signup-creator`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${anonKey}`,
      apikey: anonKey,
    },
    body: JSON.stringify({
      username: `us044_probe_${unique}`,
      tiktok_handle: `us044_probe_${unique}`,
    }),
  });
  const body = (await res.json().catch(() => null)) as
    | { token?: string; user_id?: string }
    | null;
  console.log('[signup]', res.status);
  if (res.status !== 200 || !body?.token || !body?.user_id) {
    console.error('[signup] unexpected', body);
    process.exit(1);
  }
  console.log(JSON.stringify({ user_id: body.user_id, token: body.token }));
  process.exit(0);
}

const jwt = process.env.MARKETIFY_PROBE_JWT;
const userId = process.env.MARKETIFY_PROBE_USER_ID;
const appId = process.env.MARKETIFY_PROBE_APP_ID;
const expectedStatus = process.env.MARKETIFY_PROBE_EXPECTED_STATUS ?? 'approved';

if (!jwt || !userId || !appId) {
  console.error(
    'MARKETIFY_PROBE_JWT, MARKETIFY_PROBE_USER_ID, MARKETIFY_PROBE_APP_ID are required for subscribe mode',
  );
  process.exit(1);
}

// Build a client whose HTTP fetch attaches the probe JWT on every request.
// Realtime runs on a separate websocket that doesn't go through the fetch
// wrapper — we call `realtime.setAuth(token)` explicitly below (mirrors the
// pattern in app/(creator)/applications.tsx and Codebase Pattern #105).
const probeFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${jwt}`);
  return fetch(input, { ...init, headers });
};

const supabase = createClient(supabaseUrl, anonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: { fetch: probeFetch },
});

await supabase.realtime.setAuth(jwt);

type EventPayload = { id?: string; status?: string };
let received: EventPayload | null = null;

const channel = supabase
  .channel(`probe-us044-${userId}`)
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'applications',
      filter: `creator_id=eq.${userId}`,
    },
    (payload) => {
      const next = payload.new as EventPayload;
      if (next?.id === appId) {
        received = next;
      }
    },
  )
  .subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log(`READY ${userId}`);
    } else if (
      status === 'CLOSED' ||
      status === 'CHANNEL_ERROR' ||
      status === 'TIMED_OUT'
    ) {
      console.error(`[channel] status=${status}`);
    }
  });

const timeoutMs = 60_000;
const started = Date.now();
// TS narrows the module-level `received` based on the while condition and
// can't see the callback mutation, so we pull it through a getter and
// capture into a fresh locally-typed variable after the loop exits.
const getReceived = (): EventPayload | null => received;
while (getReceived() === null) {
  if (Date.now() - started > timeoutMs) {
    console.error('[verdict] FAIL — no UPDATE event received within 60s');
    await supabase.removeChannel(channel);
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 200));
}

const event = getReceived() as EventPayload;
console.log('[event]', JSON.stringify(event));

if (event.status !== expectedStatus) {
  console.error(
    `[verdict] FAIL — expected new.status=${expectedStatus}, got ${event.status}`,
  );
  await supabase.removeChannel(channel);
  process.exit(2);
}

console.log(
  `[verdict] PASS — realtime UPDATE event delivered with new.status=${expectedStatus}`,
);
await supabase.removeChannel(channel);
process.exit(0);
