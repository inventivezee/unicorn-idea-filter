// Stripe server helpers. Requires STRIPE_SECRET_KEY, STRIPE_PRICE_ID,
// STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_APP_URL.
import Stripe from "stripe";

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY!);
  }
  return client;
}

export function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ??
    "http://localhost:3000"
  );
}
