-- Unicorn Idea Filter — Cash Cow queue backoff (head-of-line fix)
--
-- The candidate query returns unscored discovery ideas oldest-first. Ideas
-- whose scorer's provider is down (e.g. OpenAI quota exhausted) fail
-- transiently, get refunded, and stay at the head of the queue — after
-- enough cycles the entire fetch window is quota-blocked ideas and the
-- ~1,100 scoreable ideas behind them can never be fetched (this froze the
-- pipeline for 9+ hours on 2026-07-21). Transient releases now stamp a
-- next_attempt_at backoff so blocked jobs step aside.

alter table public.cashcow_jobs
  add column if not exists next_attempt_at timestamptz;

-- Replaces the 018 signature (drop first: same name, new arg list).
drop function if exists public.release_cashcow_job_transient(uuid);

create or replace function public.release_cashcow_job_transient(
  p_idea uuid,
  p_backoff integer default 300
)
returns void
language sql
as $$
  update public.cashcow_jobs
     set status = 'pending',
         claim = null,
         attempts = greatest(0, attempts - 1),
         next_attempt_at = now() + make_interval(secs => p_backoff),
         updated_at = now()
   where idea_id = p_idea;
$$;
