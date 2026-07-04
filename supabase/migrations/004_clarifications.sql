-- Unicorn Idea Filter — persist the clarifying Q&A gathered when an idea is
-- added, so the owner and admins can review the questions and answers.
-- Additive: run AFTER 001_init.sql. Idempotent.

-- Array of { "question": string, "answer": string }. Owner- and admin-visible
-- only: intentionally NOT part of the public_ideas view.
alter table public.ideas
  add column if not exists clarifications jsonb not null default '[]'::jsonb;
