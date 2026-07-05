-- Unicorn Idea Filter — founder-designed custom filters.
-- Additive + idempotent. Run AFTER 001.

-- Per-idea custom-filter verdicts, keyed by the founder's filter id:
-- { "<filterId>": { gates, scores, confidence, validationTest30d, ai,
--   snapshot } }. PRIVATE by design: computePublished ignores this column and
-- the public_ideas view never exposes it — only the owner and admins see it.
alter table public.ideas add column if not exists custom jsonb;
