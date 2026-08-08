-- Unicorn Idea Filter — Cash Cow candidate selection, deadlock fix.
--
-- 020 made blocked jobs step aside WITHIN a fixed 100-row window, but the
-- window itself never slid past them: ideas only leave it by being scored,
-- so once the 100 oldest unscored ideas were all blocked the queue was
-- permanently frozen and the per-minute cron no-opped forever (this hid two
-- multi-day stalls in July 2026 — the pipeline looked idle, not stuck).
--
-- Selecting candidates in SQL fixes it: blocked rows are excluded by the
-- query itself, so the window always slides to the oldest SCOREABLE ideas.
create or replace function public.list_cashcow_candidate_ids(
  p_limit integer,
  p_max_attempts integer
)
returns table (idea_id uuid)
language sql
stable
as $$
  select i.id
    from public.ideas i
    left join public.cashcow_jobs j on j.idea_id = i.id
   where i.origin = 'discovery'
     and (i.cashcow is null or i.cashcow->'ai' is null)
     and (
       j.idea_id is null
       or (
         j.status not in ('failed', 'done')
         and j.attempts < p_max_attempts
         and (j.next_attempt_at is null or j.next_attempt_at <= now())
       )
     )
   order by i.created_at asc
   limit p_limit;
$$;

-- One-off repair: revive ideas killed by provider-infrastructure failures
-- that were misclassified as fatal (a 44-call OpenAI 500 burst on 07-25 and
-- a 45-call Anthropic 401 burst when the deployment key was disabled on
-- 08-02). Neither is an idea-level failure; both are now transient.
-- Genuinely fatal rows (unparseable output, over the output ceiling) keep
-- their failed status and their consumed attempts.
update public.cashcow_jobs
   set status = 'pending',
       attempts = 0,
       claim = null,
       error = null,
       next_attempt_at = null,
       updated_at = now()
 where status = 'failed'
   and error ~* '\m(401|403|429|500|502|503|504|529)\M|authentication_error|timed out|timeout|upstream connect|connection termination|overloaded|quota';
