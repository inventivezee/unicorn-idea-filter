-- Unicorn Idea Filter — profile-URL lookups reuse the cv_uploads audit table.
-- Additive: run AFTER 002_cv_uploads.sql. Idempotent.

-- The source URL a founder pasted (LinkedIn / bio / personal site). Null for
-- file uploads. Lets admins see exactly what was submitted for a web lookup.
alter table public.cv_uploads add column if not exists source_url text;
-- Web searches the lookup spent (cost visibility for admins).
alter table public.cv_uploads add column if not exists web_searches integer;
-- Referrer header, mirroring submission_logs (the app's request telemetry
-- always carries it; without this column the insert would be rejected).
alter table public.cv_uploads add column if not exists referer text;
