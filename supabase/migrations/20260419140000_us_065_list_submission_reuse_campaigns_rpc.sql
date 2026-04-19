-- US-065 — ReuseBadge tap sheet: list the other campaigns this URL was
-- submitted to.
--
-- Contract: `public.list_submission_reuse_campaigns(p_submission_id uuid)`
-- returns one row per distinct *other* listing whose submissions share the
-- same video (external_id + platform match) as the input submission.
-- Columns: listing_id uuid, listing_title text.
--
-- Why SECURITY DEFINER: cross-lister reads are the whole point of the
-- badge (docs/design.md §4.6 — "some briefs permit cross-posting, others
-- require exclusivity"), but other listers' `listings` rows aren't
-- RLS-readable to the caller. DEFINER + an explicit ownership check on
-- the *input* submission is the same pattern `submission_reuse_count`
-- (us_009) uses: only the lister whose listing hosts the input submission
-- can see the list. Non-owners get an empty set (not NULL — this returns
-- a table, not a scalar; the owner-check returning zero rows is
-- indistinguishable from "no reuse", which is the correct posture).
--
-- Why a list instead of an embed in list_my_submissions_as_lister: the
-- list is lazy — the sheet only opens on tap. Loading all the other
-- campaigns up-front for every inbox row that *might* be tapped is
-- wasted work (the inbox already carries the count). Keep the count in
-- the parent RPC, fetch the titles here.
--
-- Ownership gate: identical pattern to `submission_reuse_count` — join
-- submissions → applications → listings and assert `lister_id =
-- current_user_id()`. If the gate fails, return no rows (an unauth'd
-- caller cannot distinguish "no reuse" from "not my submission", so no
-- information leak).
--
-- Duplicate-listing collapse: two submissions to the same listing with
-- the same video count as one listing in the result — GROUP BY other_l.id.
-- `listings.id` is the primary key so `min(title)` is just the title
-- itself; GROUP BY is cheaper than DISTINCT ON here because we want the
-- final ORDER BY to be on title, not on id.
--
-- Same-listing exclusion (`other_a.listing_id <> this_a.listing_id`): the
-- inbox label reads "Also submitted to N *other* campaigns". The schema
-- permits multiple submissions to the same listing (a creator can submit
-- a replacement video on the same application; `submissions_open_uniq`
-- only blocks two *open* submissions, not two terminal ones). Without
-- this filter the sheet could list the caller's own listing as a
-- "reuse" — misleading. The `submission_reuse_count` helper (us_009)
-- does NOT apply this filter; that's a separate concern for the count
-- label which reads "other campaigns" loosely. The sheet is explicit
-- ("these other campaigns") so we tighten here.
--
-- Ordering: listing_title asc so the sheet reads stably on repeat taps.
--
-- Spec deviation (docs/design.md §4.6 → US-065 AC): §4.6 line 604 says
-- the sheet should include each listing's status so the lister can see
-- whether the reuse is on an active or closed brief. The US-065 AC
-- reduces this to "titles only". We follow the AC — extending the
-- return shape to include status is a one-line change when the richer
-- variant lands (likely alongside US-059's review-screen header variant
-- per docs/design.md §4.6 header variant).
--
-- Codebase Patterns referenced:
--   #40  submission_reuse_count ownership-check DEFINER pattern
--   #42  set search_path = '' + schema-qualify every user-defined ref
--   #117 Audit PostgREST embeds / cross-tenant list reads against RLS
--   #118 SECURITY DEFINER list-my-rows skeleton (adapted for aggregate-ish result)

create or replace function public.list_submission_reuse_campaigns(p_submission_id uuid)
returns table (
  listing_id    uuid,
  listing_title text
)
language sql
stable
security definer
set search_path = ''
as $$
  select other_l.id         as listing_id,
         min(other_l.title)::text as listing_title
    from public.submissions this_s
    join public.applications this_a
      on this_a.id = this_s.application_id
    join public.listings this_l
      on this_l.id = this_a.listing_id
    join public.submission_videos this_sv
      on this_sv.submission_id = this_s.id
     and this_sv.external_id is not null
    join public.submission_videos other_sv
      on other_sv.external_id = this_sv.external_id
     and other_sv.platform    = this_sv.platform
     and other_sv.submission_id <> this_s.id
    join public.submissions other_s
      on other_s.id = other_sv.submission_id
    join public.applications other_a
      on other_a.id = other_s.application_id
     and other_a.listing_id <> this_a.listing_id
    join public.listings other_l
      on other_l.id = other_a.listing_id
   where this_s.id = p_submission_id
     and this_l.lister_id = public.current_user_id()
   group by other_l.id
   order by min(other_l.title);
$$;

comment on function public.list_submission_reuse_campaigns(uuid) is
  'ReuseBadge tap sheet source (design §4.6, AC US-065). Returns the distinct '
  'other listings whose submissions share this submission''s video. '
  'Security-definer: ownership gated on the input submission''s listing; '
  'non-owners get an empty set.';

revoke all on function public.list_submission_reuse_campaigns(uuid) from public;
revoke all on function public.list_submission_reuse_campaigns(uuid) from anon;
grant execute on function public.list_submission_reuse_campaigns(uuid) to authenticated, service_role;
