// Plan gating, quotas, and premium-model policy. Shared by client UI
// (labels/disabled states) and server routes (enforcement).
import type { Provider } from "./types";

export const SUBSCRIPTION_PRICE_LABEL = "$19 / month";

/** Models that require an active subscription. */
export const PREMIUM_MODELS = new Set(["claude-fable-5", "gpt-5.5"]);

export function isPremiumModel(model: string): boolean {
  return PREMIUM_MODELS.has(model);
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
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.1",
};
