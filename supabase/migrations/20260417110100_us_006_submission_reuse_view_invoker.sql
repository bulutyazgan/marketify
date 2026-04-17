-- Fix security_definer_view advisor on submission_reuse_view.
-- Supabase flags any view without security_invoker=on as SECURITY DEFINER,
-- which defeats the RLS-based scoping the spec relies on ("Read via RLS on
-- submissions — a lister sees reuse_count only for their own listings'
-- submissions"). Recreate with security_invoker=on so the view honors the
-- caller's RLS context.

alter view public.submission_reuse_view set (security_invoker = on);
