# SETUP — operator guide

How to deploy Unicorn Idea Filter with cloud features (accounts, public feed, subscriptions, admin). For what the app does, see [README.md](README.md).

## 1. Environment variables

| Variable | Description | Where to find it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Claude models for AI analysis (at least one of the two AI keys required) | [console.anthropic.com](https://console.anthropic.com/) → API Keys |
| `OPENAI_API_KEY` | OpenAI models for AI analysis (at least one of the two AI keys required) | [platform.openai.com](https://platform.openai.com/api-keys) → API Keys |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL; enables auth + the shared database | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase publishable (anon) key, safe for the browser | Supabase → Project Settings → API → Project API keys → `anon public` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase admin key, server-only — never expose to the browser | Supabase → Project Settings → API → Project API keys → `service_role` |
| `STRIPE_SECRET_KEY` | Stripe API secret for checkout/portal/webhook | Stripe → Developers → API keys → Secret key |
| `STRIPE_PRICE_ID` | Price id (`price_…`) of the $19/month recurring price | Stripe → Product catalog → your product → the price's ID |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_…`) of the webhook endpoint | Stripe → Developers → Webhooks → your endpoint → Signing secret |
| `NEXT_PUBLIC_APP_URL` | Canonical public URL of the deployment, e.g. `https://yourapp.vercel.app` — used for auth and Stripe redirects | Your Vercel domain |
| `ADMIN_EMAILS` | Comma-separated emails that get the admin console | You choose |

Notes:

- With **no Supabase variables** set, the app runs local-only (browser localStorage, no accounts, no public feed) — today's default behavior. AI analysis still works with just the AI keys.
- **Stripe variables are optional** until you want billing. Without them, everyone is on the free tier; the upgrade UI degrades gracefully.
- On Vercel: Project → Settings → Environment Variables, then redeploy — `NEXT_PUBLIC_*` values are baked in at build time.

## 2. Supabase

1. Create a project at [supabase.com](https://supabase.com/dashboard).
2. Open **SQL Editor** → paste the contents of [`supabase/migrations/001_init.sql (then also run supabase/migrations/002_cv_uploads.sql — it adds the CV-upload storage bucket and retained audit table)`](supabase/migrations/001_init.sql) → Run. This creates `profiles`, `ideas`, `submission_logs`, `anon_usage`, RLS policies, and the quota function.
3. **Authentication → Providers**:
   - Enable **Email** (magic link is on by default).
   - Enable **Google**. This needs an OAuth client from Google Cloud Console — follow the Supabase guide: <https://supabase.com/docs/guides/auth/social-login/auth-google>.
4. **Authentication → URL Configuration**:
   - Site URL: `https://YOURAPP` (your `NEXT_PUBLIC_APP_URL`).
   - Redirect URLs: must include `https://YOURAPP/auth/callback` (add `http://localhost:3000/auth/callback` for local dev).
5. **Project Settings → API**: copy the three keys — Project URL → `NEXT_PUBLIC_SUPABASE_URL`, `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `service_role` → `SUPABASE_SERVICE_ROLE_KEY`.

## 3. Stripe

1. Create a Product named **Unicorn Idea Filter Pro** with a **recurring $19/month** price (Product catalog → Add product).
2. Copy the price id (`price_…`) → `STRIPE_PRICE_ID`. (Price id, not product id `prod_…`.)
3. **Developers → Webhooks → Add endpoint**: URL `https://YOURAPP/api/stripe/webhook`, events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy the endpoint's signing secret (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.
5. Copy your API secret key → `STRIPE_SECRET_KEY`.
6. **Test in test mode first**: use test-mode keys and a test-mode webhook endpoint, subscribe with card `4242 4242 4242 4242` (any future expiry, any CVC). Switch all three Stripe variables to live-mode values when you go live.

## 4. Admin access

1. Put your email in `ADMIN_EMAILS` (comma-separated for multiple admins), redeploy.
2. Sign in with that exact email.
3. **/admin** appears in the account menu — idea moderation with owner emails, submission logs (including IP/device metadata), and server-side re-analysis.

## 5. Lapsed subscriptions

When a subscription is canceled or payment fails past due:

- Existing private ideas **stay private** — nothing is retroactively published.
- The user can **no longer mark new ideas private** use Claude Fable 5, or run GPT-5.5 at xhigh reasoning until they resubscribe (GPT-5.5 falls back to medium effort).
- Quotas revert to the free tier (10 analyses/month signed in; anonymous is 3/day).

## 6. Smoke test

After deploying with all variables set:

1. Open the app → sign in via magic link (check the email arrives and `/auth/callback` returns you signed in).
2. Add an idea via type-to-add.
3. Run an analysis — the quota counter should tick down (free account: 10/month).
4. Open **/explore** — the idea appears in the public feed.
5. Subscribe via test checkout (card `4242 4242 4242 4242`).
6. Confirm the webhook fired: the plan badge in **Settings** flips to subscribed.
7. Toggle the idea **private** — it disappears from /explore.
8. Sign in with an `ADMIN_EMAILS` address → open **/admin** → the idea and its submission log are visible.
