-- Unicorn Idea Filter — bring-your-own-key storage. Additive + idempotent.
-- One row per user; each provider key is stored ENCRYPTED (AES-256-GCM via
-- APP_ENCRYPTION_KEY, see src/lib/ai/crypto.ts). Service-role only (RLS on,
-- no policies) — keys are read solely by server-side provider calls, decrypted
-- in memory, never returned to any client and never in public_ideas.
create table if not exists public.user_api_keys (
  user_id uuid primary key,
  anthropic text,
  openai text,
  openrouter text,
  browserbase text,
  browserbase_project text,
  updated_at timestamptz not null default now()
);

alter table public.user_api_keys enable row level security;
