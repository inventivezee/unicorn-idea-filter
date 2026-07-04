-- Unicorn Idea Filter — CV upload storage + retained audit records.
-- Additive migration: run this AFTER 001_init.sql on an existing project
-- (Supabase SQL editor, or `supabase db push`).

-- Private bucket for raw CV files. Not public; all access is via the
-- service-role key in the app's API routes (admins get short-lived signed URLs).
insert into storage.buckets (id, name, public)
values ('cv-uploads', 'cv-uploads', false)
on conflict (id) do nothing;

-- Every CV a founder uploads is recorded here permanently. Clearing the
-- founder background in the UI does NOT delete these rows or their files —
-- admins retain the full history and the original file.
create table if not exists public.cv_uploads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  anon_key text,
  -- Which founder slot the upload was for: 'primary' or a co-founder id.
  founder_slot text not null default 'primary',
  filename text not null default '',
  mime_type text not null default '',
  size_bytes integer,
  -- Path within the cv-uploads bucket; null if the file store failed.
  storage_path text,
  -- Plain text extracted in the browser.
  extracted_text text not null default '',
  -- AI-polished founder background returned to the user.
  ai_summary text not null default '',
  provider text,
  model text,
  ip text,
  user_agent text,
  country text,
  city text,
  created_at timestamptz not null default now()
);

create index if not exists cv_uploads_created_idx
  on public.cv_uploads (created_at desc);
create index if not exists cv_uploads_user_idx on public.cv_uploads (user_id);

-- Service-role only (like submission_logs): no client policies.
alter table public.cv_uploads enable row level security;
