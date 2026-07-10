-- Unicorn Idea Filter — reframe lineage. Additive + idempotent.
-- Every rescored reframe attempt publishes as its own idea; these columns
-- record the chain (parent idea + attempt number) so Explore can show
-- "N x reframed" and the idea page can walk back to the original.
alter table public.ideas add column if not exists reframe_of uuid;
alter table public.ideas add column if not exists reframe_attempt integer;

-- Recreate the public view with the two lineage columns appended LAST
-- (same append-only pattern as migration 011's origin column).
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
  end as cc_raw_score,
  i.ai->>'model' as ai_model,
  i.ai->>'analyzedAt' as ai_analyzed_at,
  i.cashcow->'ai'->>'model' as cc_model,
  i.cashcow->'ai'->>'analyzedAt' as cc_analyzed_at,
  i.origin,
  i.reframe_of,
  i.reframe_attempt
from public.ideas i
left join public.profiles p on p.id = i.owner_id
where i.published and not i.is_private;

grant select on public.public_ideas to anon, authenticated;
