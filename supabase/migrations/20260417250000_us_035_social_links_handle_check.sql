-- US-035 — defense-in-depth: CHECK constraint mirroring the edge-function
-- handle regex directly on public.social_links.
--
-- Why: the manage-social-link edge function (and signup-creator) already
-- validate handles with /^[a-zA-Z0-9_.]{1,30}$/ before inserting, and the
-- backing RPC is revoked from anon/authenticated/public. But the table is
-- reachable via service_role (admin scripts, future edge functions,
-- migrations seeding fixtures) with no uniform gate. This check makes the
-- shape guarantee a database invariant instead of a caller-by-caller
-- convention. Zero existing rows violate the pattern at apply time.

alter table public.social_links
  add constraint social_links_handle_format_chk
  check (handle::text ~ '^[a-zA-Z0-9_.]{1,30}$');

comment on constraint social_links_handle_format_chk on public.social_links is
  'US-035 handle format invariant: matches the edge-function HANDLE_RE in manage-social-link and auth-signup-creator. Letters, numbers, underscore, dot — 1..30 chars.';
