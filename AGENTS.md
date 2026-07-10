<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Unicorn Idea Filter — project brief

Startup-idea scoring app, LIVE in production (Vercel **Pro** + Supabase + Stripe; private repo `github.com/inventivezee/unicorn-idea-filter`). Founders describe an idea; AI scores it through hard gates + weighted 0–5 criteria + a confidence multiplier into a decision (GO/BUILD … KILL/REFRAME). Scored ideas publish to a shared public database (Explore); anyone can fork a public idea or run the reframe generator on its published verdict. $19/mo subscription gates premium models, private ideas, and custom-filter design. Admin console at /admin (ADMIN_EMAILS).

## Stack & commands

Next.js 16 App Router, TypeScript strict, Tailwind v4, Vitest. Supabase via `@supabase/ssr` (NO direct client writes — every DB write goes through service-role API routes with ownership checks in `src/lib/db/*`).

- `npx tsc --noEmit && npm test && npm run build` — run all three before any commit.
- `npm run migrate` / `migrate:status` / `migrate:baseline <v>` — applies `supabase/migrations/*.sql` to the REMOTE db via the Supabase Management API. Needs `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` in `.env.local` (local-only secret, never deploy). Ad-hoc SQL: `node scripts/migrate.mjs sql "select …"`. A preflight aborts if the target db lacks `public.ideas` (the PAT can reach every project on the account — the ref is the only target selector). DB is baselined at 009 and migrated through 011; add new migrations as `012_name.sql`.
- Local dev has NO AI keys and NO Supabase env → runs in local-only mode. AI and cloud paths are only verifiable on the deployment. Never point local dev at the production database.

## The three instruments

| Instrument | Accent | Per-idea state | Public? |
|---|---|---|---|
| Unicorn | teal | `idea.gates/scores/confidence/ai` | published via `public_ideas` view |
| Cash Cow ($20M EBITDA) | amber | `idea.cashcow` (jsonb block) | published (sanitized cc_* columns) |
| Custom (founder-designed) | violet | `idea.custom[filterId]` + spec snapshot | **NEVER** — owner + admin only |

Custom filter DESIGN is premium+login gated and runs a three-model background chain (`src/lib/ai/design-chain.ts`): GPT-5.5 Pro (background mode, effort xhigh) → Claude Fable 5 (effort max, via Message Batches — batches reject the `fallbacks` param; refusals retry manually on Opus) → GPT-5.5 Pro final pass. State lives in a `drafts` row; advanced by client polling (`/api/filter-design/status`) AND an every-minute Vercel cron (`/api/cron/advance-designs`, gated by `CRON_SECRET`). Terminal transitions email the owner via Resend (`src/lib/email.ts`).

## Discovery (autonomous idea origination)

New top-level Discover section (subscriber-gated): QUALITY MODE — each run develops 1 candidate idea deeply (owner-selectable up to 3; `buildRunPanel(count)`: house models Fable 5 + GPT-5.6 Sol first, slot 3 samples the OpenRouter panel DeepSeek/Qwen/Gemini/Llama); reframers are weighted-random per task (60% the two house models rotating, 40% the OpenRouter panel) via a DETERMINISTIC seed of (runId, taskIdx) — a mid-phase model switch would corrupt loop state; model ids live ONLY in `src/lib/discovery/config.ts` — researching the live web through Browserbase real browsers (residential proxies; ONE session shared per cron invocation, timeout must OUTLIVE the 30-min invocation, no keepAlive; tools: Google search w/ verticals+pagination, page reading w/ from_char/pdf_pages continuation, scroll/click interaction, PDFs to 200pp, screenshots for vision models). Candidates are scored through the canonical unicorn instrument by a DUAL-MODEL PANEL for every idea regardless of generator (owner decision, supersedes the old cross-vendor scorer rule), A/B tested per (runId, idx) via `scoringVariant`/`scoringPanel`, TWO rounds: the first model researches+scores, then the final model scores again (told to keep the good from the first verdict, verify with its own browser, and own the score of record) — variant A = Sol first → Fable 5 max final; variant B = Fable first → Sol final; assignments recorded as non-pruned `scoring_variant` events and the finalizer shows in the published idea's ai_model (Opus 4.8 exists solely as Fable's refusal fallback); failures loop reframe→rescore automatically up to 5 times (each loop recorded as a `reframe_loop` event, excluded from event pruning; EVERY rescored attempt publishes as its own idea via `reframeAttemptIdeaId` — attempt 1 reuses the task's pre-assigned reframe id, `idea_reframe_id` tracks the latest; lineage columns `ideas.reframe_of`/`reframe_attempt` (migration 013, exposed in `public_ideas`) power the "N× reframed" badge and the clickable chain back to the original); everything terminal-scored publishes to the owner's pipeline and Explore (`origin='discovery'`, "Discovered" badge). Research phases carry full transcripts into synthesis (no lossy brief-only funnels), generation gets a red-team critique stage, and cap-death forces one final no-tools deliverable turn. State: `discovery_runs`/`discovery_tasks` (migration 011; `public_ideas` widened by exactly `origin`), advanced by a second every-minute cron `/api/cron/advance-discovery` (same `CRON_SECRET` contract). Spend protocol mirrors the design chain: turn counters bump inside the claim CAS before any provider call, 15-min lease/heartbeat on task rows, per-phase `TURN_CAPS` + `RUN_TOTAL_TURN_CAP` + a browser-minutes cap (charged pessimistically at claim time), background (pro-mode) jobs polled free at cron cadence, atomic publish at candidate-terminal with deterministic idea uuids (crash retries converge, no duplicates). `playwright-core`/`@browserbasehq/sdk` must stay LAZY-imported — module-scope imports 500'd every route that transitively touched `browserbase.ts` on Vercel — and `playwright-core` stays in `next.config.ts` `serverExternalPackages`.

## Hard invariants — do not break

1. **Spend safety:** every paid provider call in the design chain must sit behind a CAS-won, budget-counted claim (`pending_submit` → `in_flight`, submit counters bumped at claim time, `MAX_SUBMITS_PER_STAGE`). Never add a provider submission outside this protocol; concurrent pollers/crons race constantly and must not double-bill.
2. **Privacy:** `public_ideas` view is the ONLY public surface. `computePublished` must never look at `idea.custom`. Founder backgrounds, rationales, and custom-filter verdicts are never public. Drafts are owner + admin only.
3. **Publishing side-effect:** `computePublished` publishes an idea the moment ANY gate/score exists — this is why forks copy text only (a verdict-carrying fork would instantly republish a duplicate) and why `applyCustomToIdea` never touches `published`.
4. **Anthropic structured-output schemas must stay lean** — the constrained-decoding grammar has a hard size limit (`schema-size.test.ts` guards budgets; keep scoring semantics in prompts, not schemas).
5. **Migration drift tolerance:** writes go through `writeToleratingMissingColumns` (PGRST204 strips unknown columns and retries) — new features must degrade, never lose user data, when a migration hasn't run yet.
6. **Payload caps are escape-aware:** the drafts payload cap measures `JSON.stringify` length; user text and model output stored in chain state must pass through `capEscaped`/`truncateDesign` (quotes/control chars serialize at 2–6×).
7. **Clarifications are instrument-tagged** (`"unicorn" | "cashcow" | "custom:<id>"`) via `hasClarificationsFor`; custom spec normalization (`normalizeCustomFilterSpec`) resequences ids `g1../c1..` and largest-remainder-rescales weights to exactly 100 — routes must use the NORMALIZED spec, never the raw client body.
8. **Vercel-Pro-only config:** `maxDuration = 800` and the `* * * * *` cron in `vercel.json` fail the build on a Hobby account.
9. Anonymous identity = `anon_key` (localStorage); the shared private-mode fallback key is rejected server-side (`anonKeyFromBody`) — never treat it as an ownership identity. Sign-in claims anon ideas AND drafts (auth callback).
10. **Discovery spend:** every discovery provider call sits behind a turn-counted claim CAS on the `discovery_tasks` row — never add a provider call outside the claim protocol in `src/lib/discovery/engine.ts`. Concurrent cron invocations race constantly; the lease/heartbeat is the only thing preventing double-billing.

## Env vars

Vercel (production): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (both required for the design chain), `OPENROUTER_API_KEY` + `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` (discovery; missing any → discovery routes 503 cleanly, cron reports disabled), `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_*`, `NEXT_PUBLIC_APP_URL`, `ADMIN_EMAILS`, `CRON_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM` (verified Resend domain). Optional discovery brakes: `DISCOVERY_USER_DAILY_CAP` / `DISCOVERY_GLOBAL_DAILY_CAP` (unset = unlimited, per owner decision; per-run budgets still bound worst case).
`.env.local` (local only, gitignored): `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` — migration tooling only.

## Working conventions in this repo

- Adversarially review substantive changes before pushing (concurrency, spend, privacy have bitten before — the CAS protocol exists because reviews found real double-billing races).
- Commit messages explain the why; push to `main` deploys production via Vercel.
- The engine layers are pure and unit-tested (`engine.test.ts`, `cashcow/engine.test.ts`, `custom/engine.test.ts`); fixture decisions in tests are contracts — don't change thresholds casually.
