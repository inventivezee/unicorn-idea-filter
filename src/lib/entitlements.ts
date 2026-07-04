// Plan gating, quotas, and premium-model policy. Shared by client UI
// (labels/disabled states) and server routes (enforcement).
import type { Provider } from "./types";

export const SUBSCRIPTION_PRICE_LABEL = "$19 / month";

/**
 * Premium gating is by model FAMILY (same patterns the provider dispatcher
 * uses for capability selection), so "claude-mythos-5" or dated snapshots
 * can't slip past the paywall via the custom-model input. GPT-5.5 is NOT
 * hard-gated: free tier runs it at medium reasoning effort, subscribers get
 * xhigh (see the effort policy in src/lib/ai/server.ts).
 */
export const PREMIUM_MODEL_PATTERNS: RegExp[] = [/^claude-(fable-5|mythos-5)/];

/** Canonical premium model ids, for UI labels. */
export const PREMIUM_MODELS = new Set(["claude-fable-5"]);

export function isPremiumModel(model: string): boolean {
  return PREMIUM_MODEL_PATTERNS.some((p) => p.test(model));
}

/** Anonymous visitors: full analyses per day (per IP and per device key). */
export const ANON_ANALYSES_PER_DAY = 3;
/** Free signed-in accounts: full analyses per calendar month. */
export const FREE_ANALYSES_PER_MONTH = 10;

export type SubscriptionStatus =
  | "none"
  | "active"
  | "trialing"
  | "past_due"
  | "canceled";

export function isSubscribed(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing";
}

/** Client-side snapshot of the caller's plan, served by GET /api/me. */
export interface Entitlements {
  signedIn: boolean;
  email: string | null;
  displayName: string;
  showHandle: boolean;
  isAdmin: boolean;
  subscribed: boolean;
  subscriptionStatus: SubscriptionStatus;
  /** Remaining full analyses in the current window (null = unlimited). */
  analysesRemaining: number | null;
  premiumModels: string[];
}

export const DEFAULT_MODEL_FALLBACKS: Record<Provider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.5",
};
