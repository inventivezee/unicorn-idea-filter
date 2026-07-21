-- Unicorn Idea Filter — release a Cash Cow job after a TRANSIENT failure
-- (provider 429/quota/rate-limit) without consuming its attempt budget, so
-- a temporary provider outage can never permanently kill an idea's scoring.
-- Resets to pending, clears the claim, and undoes the claim's attempt bump.
create or replace function public.release_cashcow_job_transient(p_idea uuid)
returns void
language sql
as $$
  update public.cashcow_jobs
     set status = 'pending',
         claim = null,
         attempts = greatest(0, attempts - 1),
         updated_at = now()
   where idea_id = p_idea;
$$;
