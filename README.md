# Unicorn Idea Filter

Score startup ideas against a unicorn/IPO bar **before** committing years to one. Nine hard pass/fail gates, fifteen weighted criteria (0–5 with scoring anchors), a confidence multiplier, and a decision engine that tells you: **BUILD / INCUBATE**, **VALIDATE FAST**, **PARK / NARROW**, or **KILL**.

Describe your idea, add your founder background (paste text or upload a CV), and let AI propose every gate, score, confidence level, and a 30-day validation test — with a rationale for each. Everything stays manually editable; the AI is a first pass, not the judge.

## Features

- **Type-to-add** — describe the idea in one box; the AI names it, fills in the metadata (domain, business model, buyer, wedge), and scores it.
- **Pipeline** — sortable table of all ideas with gate status, raw/adjusted scores, decision chips, killer-flaw flags, and CSV export.
- **Idea detail** — gates first (a single N kills the idea, no averaging), then 0–5 scoring with inline anchors and keyboard input, confidence, computed top risks, and a 30-day validation test.
- **AI analysis** — one click (or the type-to-add flow) fills the metadata and the whole scorecard from your idea + founder background (Anthropic Claude — including Fable 5 at xhigh effort — or OpenAI models up to GPT-5.5 with xhigh reasoning, selectable in Settings), optionally grounded with live web search. Founder-personal gates (10-year commitment, unfair advantages) are flagged for manual confirmation, never silently auto-answered.
- **Compare** — 2–3 ideas side by side: per-criterion deltas, gates matrix, totals.
- **Dashboard** — decision counts, top idea, killer risks across the pipeline, and a seeded stress test: how often does your leader stay #1 when every weight is perturbed ±20%?
- **Outcome math** — exit calculator (valuation ÷ multiple = required revenue) plus multiple scenarios.
- **Reference** — $1B benchmarks per business model: IPO-quality targets, early proof signals, kill risks.
- **Explore** — a public database of every scored idea, browsable by anyone, sortable by newest or top score.
- **Accounts** — sign in with a magic link (email) or Google. Anonymous use works too, with a daily analysis quota; sign in to raise it, subscribe ($19/month) for unlimited fair-use plus private ideas and the premium models (Claude Fable 5, GPT-5.5).
- **Admin console** — idea moderation, submission logs, and re-analysis for operators listed in `ADMIN_EMAILS`.
- **Settings** — founding team backgrounds (text or CV upload: PDF / DOCX / TXT parsed in-browser; co-founders supported — founder–market fit scores as the strongest founder's fit; your own background is required before analysis), AI provider + model, editable criterion weights (auto-normalized), JSON backup/restore.

## Privacy model

- **Scored ideas are public by default.** When cloud sync is configured, every idea you score is published to a shared database and appears on the Explore page. Treat the idea's name, metadata, gates, and scores as public.
- **Your founder data is never public.** Founder backgrounds, co-founders, per-item rationales, and validation plans are stored but never exposed on the public feed — only you (and site admins) can see them. Public ideas instead carry an **anonymised founding-team profile**: an AI-written 1–3 sentence summary of expertise and advantages with no names, employers, or identifying details, which you can edit on the idea page.
- **Anonymous usage is allowed.** No account is needed to score or publish ideas; a random device key in localStorage lets you keep editing what you created. The server logs IP address and device metadata with each submission — these logs are visible only to admins.
- **Private ideas are a subscriber feature.** Subscribers ($19/month) can mark any idea private, which removes it from the public feed. The subscription also unlocks the premium models (Claude Fable 5, GPT-5.5).
- **Quotas:** anonymous visitors get 3 full analyses/day, free accounts 10/month, subscribers unlimited (fair use).
- **Without Supabase configured**, the app behaves as before: all idea data lives in your browser's localStorage, nothing is published anywhere. Use Settings → Export JSON for backups.
- CV parsing happens **in the browser**; the extracted text is only sent to the AI provider when you click *Analyze*.
- AI calls run through a serverless route using API keys held **server-side as environment variables** — keys never reach the browser.

## Deploy to Vercel

1. Import this repo at [vercel.com/new](https://vercel.com/new) (framework auto-detected: Next.js).
2. Add environment variables (Project → Settings → Environment Variables). Minimum: `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` — set at least one; Settings in the app shows which providers are live. For the full list (Supabase auth + public database, Stripe billing, admin access) see **[SETUP.md](SETUP.md)**.
3. Deploy. With only the AI keys set, the app runs local-only: anyone you share the URL with gets their own private, browser-local workspace and uses your configured keys for AI analysis. Add the Supabase and Stripe variables from [SETUP.md](SETUP.md) to turn on accounts, the public feed, and subscriptions.

> **Cost note:** the analyze endpoint spends *your* API credits and is open to anyone who can reach the deployment. It enforces same-origin requests, caps input sizes, and rate-limits per IP (best effort on serverless), but for a widely shared URL you should also set spend limits in your Anthropic/OpenAI dashboards, and consider Vercel's deployment protection if you want to restrict who can open the app at all.

## Local development

```bash
npm install
cp .env.example .env.local   # add your API keys
npm run dev                  # http://localhost:3000
npm test                     # scoring-engine acceptance tests (Vitest)
```

## Scoring semantics (exact)

```
rawScore   = Σ(score_i × weight_i) / (5 × Σweights) × 100     # 0–100, needs all 15 scored
adjusted   = rawScore × confidence                             # confidence ∈ {0.5, 0.75, 1.0}
gateStatus = FAIL if any gate is N · PENDING if any unanswered · PASS if all gates Y

decision   = KILL / REFRAME   if gates FAIL
           = PENDING GATES    if gates unanswered
           = PENDING SCORES   if not fully scored
           = BUILD / INCUBATE if raw ≥ 85 and confidence ≥ 0.75 and gates PASS
           = VALIDATE FAST    if raw ≥ 75
           = PARK / NARROW    if raw ≥ 65
           = KILL             otherwise
```

Top risks = the two criteria with the highest `(5 − score) × weight`. Killer flaw = score ≤ 2 on a weight ≥ 8 ("validate it, don't average it"). The engine lives in [`src/lib/engine.ts`](src/lib/engine.ts) — pure, dependency-free, covered by the acceptance tests in [`src/lib/engine.test.ts`](src/lib/engine.test.ts).

## Stack

Next.js (App Router) · React · TypeScript · Tailwind CSS · Anthropic + OpenAI SDKs (structured JSON output) · Supabase (auth + Postgres, optional) · Stripe subscriptions (optional) · Vitest · localStorage persistence when running without a backend.
