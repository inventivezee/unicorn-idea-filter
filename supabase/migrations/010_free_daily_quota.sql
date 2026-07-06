-- 010_free_daily_quota.sql
-- Free signed-in tier moves from a calendar-MONTH quota window to a per-UTC-DAY
-- window (the app now passes a daily limit via p_limit). The existing
-- profiles.analyses_used / analyses_reset_at columns are reused unchanged — only
-- the reset cadence changes, so no data is migrated or lost: any pre-existing
-- counter simply rolls over on the next call once its stored day is in the past.
--
-- The daily LIMIT value lives in the app (FREE_ANALYSES_PER_DAY), never here —
-- these functions only decide when the window rolls over, matching the original
-- month-based logic with date_trunc('day', ...) instead of ('month', ...).
--
-- The day is computed in EXPLICIT UTC (now() AT TIME ZONE 'UTC') rather than the
-- session timezone, so enforcement here can never drift from the UTC-day display
-- in /api/me (toISOString().slice(0,10)) if the DB session tz is ever changed.
--
-- CREATE OR REPLACE preserves the existing service-role-only ACLs, but the
-- revokes are re-issued for defense in depth (invariant: quota RPCs must never
-- be callable via the public anon key / PostgREST).

-- Atomically consume one free-tier analysis for a signed-in user; the window
-- resets each UTC day. Returns false when the daily cap is reached.
create or replace function public.consume_free_analysis(
  p_user uuid,
  p_limit integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed boolean := false;
begin
  update profiles
  set
    analyses_used = case
      when date_trunc('day', analyses_reset_at at time zone 'UTC')
             < date_trunc('day', now() at time zone 'UTC') then 1
      else analyses_used + 1
    end,
    analyses_reset_at = now()
  where id = p_user
    and (
      date_trunc('day', analyses_reset_at at time zone 'UTC')
        < date_trunc('day', now() at time zone 'UTC')
      or analyses_used < p_limit
    );
  if found then
    v_allowed := true;
  end if;
  return v_allowed;
end;
$$;

-- Refund one consumed analysis after a provider failure (best-effort); only
-- valid within the same UTC day the analysis was consumed.
create or replace function public.refund_free_analysis(
  p_user uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set analyses_used = greatest(analyses_used - 1, 0)
    where id = p_user
      and date_trunc('day', analyses_reset_at at time zone 'UTC')
            = date_trunc('day', now() at time zone 'UTC');
end;
$$;

revoke execute on function public.consume_free_analysis(uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.refund_free_analysis(uuid)
  from public, anon, authenticated;
