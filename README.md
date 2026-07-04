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
- **Settings** — founder background (text or CV upload: PDF / DOCX / TXT parsed in-browser), AI provider + model, editable criterion weights (auto-normalized), JSON backup/restore.

## Privacy model

- All idea data lives in **your browser's localStorage** — there is no database and no accounts. Use Settings → Export JSON for backups.
- CV parsing happens **in the browser**; the extracted text is only sent to the AI provider when you click *Analyze*.
- AI calls run through a serverless route using API keys held **server-side as environment variables** — keys never reach the browser.

## Deploy to Vercel

1. Import this repo at [vercel.com/new](https://vercel.com/new) (framework auto-detected: Next.js).
2. Add environment variables (Project → Settings → Environment Variables):
   - `ANTHROPIC_API_KEY` — for Claude models
   - `OPENAI_API_KEY` — for OpenAI models
   - Set at least one; Settings in the app shows which providers are live.
3. Deploy. Anyone you share the URL with gets their own private, browser-local workspace and uses your configured keys for AI analysis.

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

Next.js (App Router) · React · TypeScript · Tailwind CSS · Anthropic + OpenAI SDKs (structured JSON output) · Vitest · localStorage persistence (no backend database).
