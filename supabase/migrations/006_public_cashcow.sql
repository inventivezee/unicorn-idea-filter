-- Unicorn Idea Filter — publish Cash Cow verdicts to the public database.
-- Additive + idempotent. Includes 005's column so this can be run standalone
-- (run AFTER 001; supersedes 005 if you haven't run it yet).

alter table public.ideas add column if not exists cashcow jsonb;

-- Rebuild the public view with SANITIZED cash-cow columns appended. Same
-- privacy rule as the unicorn instrument: gate values, scores, confidence and
-- the AI summary are public; the full AI rationales are NOT exposed.
create or replace view public.public_ideas as
select
  i.id,
  i.name,
  i.domain,
  i.business_model,
  i.buyer_icp,
  i.initial_wedge,
  i.thesis_notes,
  i.gates,
  i.scores,
  i.confidence,
  i.raw_score,
  i.ai_summary,
  i.founder_profile,
  case
    when p.show_handle and coalesce(p.display_name, '') <> '' then p.display_name
    else null
  end as author_handle,
  i.created_at,
  i.updated_at,
  i.cashcow->'gates' as cc_gates,
  i.cashcow->'scores' as cc_scores,
  (i.cashcow->>'confidence')::numeric as cc_confidence,
  i.cashcow->'ai'->>'summary' as cc_summary,
  -- Raw score under the fixed cash-cow weights (sum 100): Σ(score·w)/5.
  -- Null unless all 18 criteria carry a numeric score, matching the engine.
  case
    when i.cashcow is null then null
    when jsonb_typeof(i.cashcow->'scores'->'cc_pain') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_wtp') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_reach') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_speed') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_gm') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_ebitda') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_fcf') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_control') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_dist') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_retention') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_pricing') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_ops') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_capital') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_moat') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_exit') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_fmf') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_impact') is distinct from 'number'
      or jsonb_typeof(i.cashcow->'scores'->'cc_transfer') is distinct from 'number'
      then null
    else (
        (i.cashcow->'scores'->>'cc_pain')::numeric * 6
        + (i.cashcow->'scores'->>'cc_wtp')::numeric * 6
        + (i.cashcow->'scores'->>'cc_reach')::numeric * 5
        + (i.cashcow->'scores'->>'cc_speed')::numeric * 6
        + (i.cashcow->'scores'->>'cc_gm')::numeric * 5
        + (i.cashcow->'scores'->>'cc_ebitda')::numeric * 9
        + (i.cashcow->'scores'->>'cc_fcf')::numeric * 8
        + (i.cashcow->'scores'->>'cc_control')::numeric * 7
        + (i.cashcow->'scores'->>'cc_dist')::numeric * 6
        + (i.cashcow->'scores'->>'cc_retention')::numeric * 6
        + (i.cashcow->'scores'->>'cc_pricing')::numeric * 6
        + (i.cashcow->'scores'->>'cc_ops')::numeric * 4
        + (i.cashcow->'scores'->>'cc_capital')::numeric * 5
        + (i.cashcow->'scores'->>'cc_moat')::numeric * 6
        + (i.cashcow->'scores'->>'cc_exit')::numeric * 4
        + (i.cashcow->'scores'->>'cc_fmf')::numeric * 5
        + (i.cashcow->'scores'->>'cc_impact')::numeric * 2
        + (i.cashcow->'scores'->>'cc_transfer')::numeric * 4
      ) / 5.0
  end as cc_raw_score
from public.ideas i
left join public.profiles p on p.id = i.owner_id
where i.published and not i.is_private;

grant select on public.public_ideas to anon, authenticated;
