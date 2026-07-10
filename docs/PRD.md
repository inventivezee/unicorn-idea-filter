# Unicorn Idea Filter — Product Requirements Document

| | |
|---|---|
| **Version** | 2.1 |
| **Date** | July 10, 2026 |
| **Owner** | Zee (Innovate Abundance LLC) |
| **Status** | Shipped — documents the live product including the July 2026 release |
| **Production** | Vercel Pro + Supabase; repo `github.com/inventivezee/unicorn-idea-filter` |

---

## 1. Product overview

Unicorn Idea Filter is an AI-powered decision instrument for startup ideas. A founder describes an idea; the AI interrogates it (clarifying questions), scores it through **hard pass/fail gates** and **weighted 0–5 criteria** with a confidence multiplier, and returns a decision on a ladder from **GO / BUILD** down to **KILL / REFRAME** — with per-criterion rationales, top risks, and a 30-day validation test. Scored ideas publish (sanitized) to a shared public database that anyone can browse, fork, and improve.

The July 2026 release (this document's focus, §4) extends the product from *two fixed scoring instruments* to *personal ones*, makes long AI jobs survive a closed browser, persists unfinished work as drafts, notifies founders by email, and turns the public database into a remixable commons.

### 1.1 The three instruments

| Instrument | Question it answers | Visual identity | Availability |
|---|---|---|---|
| **Unicorn Filter** | Can this be a venture-scale ($1B+) company? | Teal | Everyone |
| **Cash Cow Filter** | Can this reach $20M+ EBITDA/yr with durable enterprise value? | Amber | Everyone |
| **Custom Filter** | Whatever the founder actually wants — e.g. "$1M/yr at 5 hrs/day, solo, never selling" | Violet | Design: subscribers. Use: owner only |

Ideas are shared across instruments; each instrument keeps its own gates/scores/verdict per idea, switchable from the brand dropdown.

---

## 2. Problem statements

1. **Not everyone wants a unicorn.** Many founders want $1M/yr and a good life; scoring their idea against a venture bar produces advice that is wrong *for them*. → Custom filters.
2. **Deep AI work takes longer than a page view.** The best design/reasoning models need 10–40 minutes; founders will not keep a tab open. → Background jobs + cron + email.
3. **Half-finished thoughts evaporate.** An idea typed at midnight and abandoned mid-wizard was lost. → Drafts.
4. **A public database that can only be read is a dead end.** The compounding value is in *remixing* — taking a weak public idea and making it yours, better. → Forking + public reframes.

---

## 3. Users

- **Lifestyle founder** — wants a specific income/effort/horizon outcome; the custom filter's primary persona. Likely subscriber.
- **Venture founder** — uses the unicorn/cash-cow bars; free or subscriber.
- **Browser / remixer** — arrives via a shared public idea; forks and reframes; the top of the acquisition funnel. Anonymous allowed.
- **Admin (owner)** — full visibility: all ideas, drafts, custom filters, telemetry, CV uploads; can run any idea through any built-in filter as-is.

### 3.1 Entitlements matrix

| Capability | Anonymous | Free account | Subscriber ($19/mo) | Admin |
|---|---|---|---|---|
| Add/score ideas (standard models) | 3 analyses/day | 10/mo | Unlimited (fair use) | Unlimited |
| Premium models (Fable 5, GPT-5.5 xhigh) + uncapped web search | — | — | ✓ | ✓ |
| Fork public ideas / reframe public ideas | ✓ | ✓ | ✓ | ✓ |
| Drafts (autosave + resume) | ✓ (device-bound) | ✓ (cross-device) | ✓ | ✓ + sees all |
| **Design custom filters** | — | — | ✓ (6 designs/day) | ✓ |
| **Discovery runs** (autonomous idea origination) | — | — | ✓ (unlimited runs/day, one running at a time) | ✓ |
| Private ideas | — | — | ✓ | ✓ |

---

## 4. The July 2026 release — feature requirements

### 4.1 Founder-designed custom filters

**What:** A founder states their real goals — target net profit/yr, hours/day (with a kind nudge that building typically demands 8+), years to build, capital available, max team size, sell intention, and free-text "anything else that matters" — and the system designs a complete scoring instrument around them: 5–8 hard gates and 8–12 weighted criteria with 0/3/5 anchors, weights summing to exactly 100.

**How the design is produced — the three-model chain (fixed, per product decision):**
1. **ChatGPT 5.5 Pro** (`gpt-5.5-pro`, reasoning effort `xhigh` — its maximum) designs the instrument from a detailed brief that forces the arithmetic (profit ÷ pricing → customer counts; hours ceiling → automation demands).
2. **Claude Fable 5** (effort `max`) adversarially reviews it — checks every stated number is encoded, the math adds up, criteria don't overlap — and outputs an improved full spec.
3. **ChatGPT 5.5 Pro** (`xhigh`) reconciles both versions into the final instrument.

The founder previews the result (gates, criteria, weights, provenance note) and **accepts or regenerates** — no manual editing of specs. Up to **5 saved filters**, each versioned; redesigning bumps the version and old verdicts on ideas remain renderable via per-idea spec snapshots (with a "scored under v1, re-run" note).

**UX requirements (shipped):**
- The UI states plainly that stage 1 alone typically takes **10–15 minutes**, shows live 3-stage progress with elapsed time, and tells the founder they can close the tab or the whole browser.
- Full instrument parity once accepted: analyze, instrument-tagged clarifying questions, "Help me generate," reframe, pipeline table, idea sections, verdict panel — all violet-themed and spec-driven.
- **Privacy invariant:** custom-filter verdicts are never published. Owner and admin only.

**Gating & cost control (shipped):**
- Requires a signed-in **subscriber** (or admin); server-enforced with sign-in/upgrade CTAs.
- 6 designs per user per day, metered *before* any model spend.
- One running design per user, enforced by a database unique index.
- Every paid model call sits behind a claimed, budget-counted state transition (max 3 submissions per stage), so concurrent tabs/crons can never double-bill; chains have hard deadlines (6h/stage, 24h total) and cancel their provider jobs when discarded.

### 4.2 Background execution (close-the-browser)

- The chain runs via provider-side async surfaces (OpenAI background mode; Anthropic Message Batches) — no server holds a connection.
- Progress is advanced by client polling **and** a **Vercel cron every minute** (`/api/cron/advance-designs`, authenticated by `CRON_SECRET`, fail-closed), so chains progress with zero browsers open. Fair scheduling: shuffled job order + time budget.
- AI-heavy API routes run at **800s max duration** (Vercel Pro GA limit) — premium analyses with uncapped web search get full headroom. *These settings fail the build on a Hobby plan by design.*

### 4.3 Drafts

- **Idea drafts:** an unfinished Quick Add (description, chosen mode, mid-flight clarifying answers) autosaves to the cloud (debounced 1.5s), keyed to the account or anonymous device. A "pick up where you left off" banner lists up to 3 with Resume/Discard; completing the add cleans up. Signing in claims anonymous drafts.
- **Filter-design drafts:** the goals form autosaves; a running/finished/failed design *is* a draft row, so it survives reloads and device switches. Failed designs resurface with one-click retry.
- **Admin visibility:** a Drafts section on /admin lists every user's drafts — kind, owner, status (including chain stage), content preview.
- Caps: 20 drafts/owner, size-capped payloads, origin/rate-guarded API.

### 4.4 Email notifications (Resend)

- When a design chain reaches a terminal state, the owner receives exactly one email: **"Your custom filter '[name]' is ready"** (review CTA) or **"needs another try"** (reason + retry CTA).
- Sent by the state transition's single winner — never duplicated by racing pollers/crons; mail failure never breaks the chain; feature silently disabled when unconfigured.
- Config: `RESEND_API_KEY` + `EMAIL_FROM` on a Resend-verified domain (fallback sender delivers only to the Resend account owner — testing only).

### 4.5 Public forking & public reframes

- **Fork:** every public idea page shows non-owners a "⑂ Fork into my pipeline" button. Forks copy the idea's text and metadata — **deliberately not the verdict** (a scored fork would instantly republish as a duplicate in the public feed). The forker scores it against their own background. Owners see "Open in my pipeline" instead.
- **Reframe on public ideas:** when a public idea's published verdict is weak (KILL/REFRAME or PARK/NARROW in the active instrument), the reframe generator appears directly on the public page, fed by the sanitized public scores and AI summary. Generated reframes are added to the **viewer's** pipeline as fresh ideas; the original is never modified. Works anonymously — a visitor's first owned idea can be "a better version of someone else's."

### 4.6 Developer/ops tooling (internal)

- **API-based migrations:** `npm run migrate` applies `supabase/migrations/*.sql` through the Supabase Management API — no more SQL-editor copy-paste. Includes status/baseline/ad-hoc-SQL commands, CLI-compatible tracking, per-migration transactions, and a wrong-project preflight guard. Production DB baselined at migration 009.

### 4.7 Discovery — autonomous idea origination (July 10 follow-up)

**What:** A new top-level **Discover** section where a subscriber launches a run that *originates* ideas instead of scoring their own. AI agents across six models — 30% Claude Fable 5, 30% GPT-5.6 Sol, and the rest split evenly across DeepSeek V4 Pro / Qwen3.7 Max / Gemini 3.1 Pro / Llama 4 Maverick via OpenRouter — research the live web through **Browserbase real browsers** (residential proxies) and generate **20 candidate ideas per run**. Model ids live only in `src/lib/discovery/config.ts`.

**Scoring & publishing:** every candidate is scored through the canonical unicorn instrument (scoring normalization shared verbatim with the analyze route) under a hard **cross-vendor rule** — an idea is never scored by the model family that wrote it. Failing candidates get exactly one auto-reframe (reframer weighted-random per task: 60% the two house models rotating between each other, 40% one of the OpenRouter models) and a cross-vendor rescore. Everything scored lands in the owner's pipeline and publishes to Explore with `origin='discovery'` and a "Discovered" badge.

**Background execution:** runs survive closed browsers via a second every-minute cron (`/api/cron/advance-discovery`, same `CRON_SECRET` contract as §4.2); one Browserbase session is shared per cron invocation (no keepAlive, self-terminating timeout); owners get a completion email.

**Cost control (same discipline as §4.1):** turn counters bump inside the claim CAS *before* any provider call; 15-minute lease/heartbeat claims on `discovery_tasks`; per-phase and per-run turn caps plus a pessimistic browser-minutes budget; background (pro-mode) jobs are polled for free at cron cadence; atomic publish at candidate-terminal with deterministic idea uuids, so crash retries converge without duplicates. Optional env brakes `DISCOVERY_USER_DAILY_CAP` / `DISCOVERY_GLOBAL_DAILY_CAP` default to unlimited per product decision.

**Data & config:** migration 011 adds `discovery_runs`/`discovery_tasks` and widens `public_ideas` by exactly one column (`origin`). New env: `OPENROUTER_API_KEY`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` — dormant-safe without them (routes 503 cleanly, cron reports disabled). The browser packages (`playwright-core`, `@browserbasehq/sdk`) are lazy-imported by requirement — module-scope imports took down every route on Vercel — with `playwright-core` in `serverExternalPackages`.

---

## 5. Non-functional requirements

| Category | Requirement (shipped state) |
|---|---|
| **Cost safety** | No unmetered model spend: metering precedes submission; claims precede every paid call; per-stage retry budgets; daily caps; provider-job cancellation on discard/timeout. Worst-case spend per design is bounded and admin-auditable via `submission_logs`. |
| **Privacy** | `public_ideas` view is the only public surface (sanitized; no founder backgrounds, no rationales). Custom filters/verdicts and drafts: owner + admin only. Anonymous fallback identity is never trusted as ownership. |
| **Reliability** | Chains self-heal (expired background results resubmit within budget); nothing can stay "designing" forever (deadlines); terminal state transitions always land (size-capped fallback writes). |
| **Concurrency** | All draft/chain writes are CAS- or condition-guarded; concurrent tabs, devices, and crons race safely (adversarially reviewed; ~90 agent-verifications across the release). |
| **Degradation** | Missing env (Resend, Supabase, AI keys) degrades features silently or with clear errors — never crashes. Migration drift tolerated on writes. |

---

## 6. Configuration reference

**Vercel (production):** `ANTHROPIC_API_KEY` + `OPENAI_API_KEY` (both required for the chain), `OPENROUTER_API_KEY` + `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` (discovery), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` / `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL`, `ADMIN_EMAILS`, `CRON_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`. Optional: `DISCOVERY_USER_DAILY_CAP` / `DISCOVERY_GLOBAL_DAILY_CAP` (unset = unlimited).

**Local `.env.local` (never deployed):** `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` — migration tooling only.

---

## 7. Success metrics (to instrument — see roadmap)

- **Activation:** % of visitors who run a first analysis; % of forks/reframes that become a scored idea.
- **Custom-filter adoption:** designs started, completion rate of the chain, accept-vs-regenerate ratio, share of subsequent analyses run in custom mode.
- **Notification efficacy:** open→return rate on "filter ready" emails.
- **Conversion:** free→subscriber rate, with custom-filter design as the hypothesized top driver.
- **Cost:** model spend per design / per analysis vs. subscription revenue (admin logs already capture runs).

## 8. Out of scope / next (discussed, not committed)

Score history per idea (verdict trajectory), shareable verdict cards with OG images + SEO, day-30 validation-test follow-up emails, product analytics (PostHog), multi-model consensus scoring as a premium tier, public pricing page.

---

## 9. Release log (this release)

| Commit | Change |
|---|---|
| `2074bde` | Custom filters: AI-designed private scoring instruments (single-model v1) |
| `dfcdd9c` | Three-model design chain, premium gating, drafts system, migration 009 |
| `bffa773` | API-based migration runner (`npm run migrate`) |
| `423535d` | Vercel Pro: 800s durations + every-minute cron advances chains browserlessly |
| `eb84e90` | Resend email notifications; first-class forking; reframes on public ideas |
| `431fc04` | AGENTS.md project brief (agent-session onboarding) |
| `3588acf` | Discovery: autonomous multi-vendor idea origination engine (§4.7; migration 011, second every-minute cron) |
| `0dea7fc` | Discovery: lazy-load playwright-core + Browserbase SDK (module-scope imports 500'd every route on Vercel) |
