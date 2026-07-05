-- Unicorn Idea Filter — Cash Cow Filter scoring block.
-- Additive: run AFTER 001_init.sql. Idempotent.

-- Per-idea Cash Cow Filter block: { gates, scores, confidence,
-- validationTest30d, ai }. Independent of the unicorn columns; the public
-- feed (public_ideas view) remains driven by the unicorn instrument.
alter table public.ideas add column if not exists cashcow jsonb;
