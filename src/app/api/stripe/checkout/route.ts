// Start a $19/month subscription via Stripe Checkout.
import { appUrl, stripe, stripeConfigured } from "@/lib/stripe";
import {
  adminClient,
  cloudConfigured,
  resolveCaller,
} from "@/lib/supabase/server";

export async function POST() {
  if (!cloudConfigured() || !stripeConfigured()) {
    return Response.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 },
    );
  }
  const caller = await resolveCaller();
  if (!caller.user || !caller.profile) {
    return Response.json(
      { error: "Sign in before subscribing." },
      { status: 401 },
    );
  }
  if (caller.subscribed) {
    return Response.json(
      { error: "You already have an active subscription." },
      { status: 400 },
    );
  }

  const s = stripe();
  let customerId = caller.profile.stripe_customer_id;
  if (!customerId) {
    const customer = await s.customers.create({
      email: caller.user.email ?? undefined,
      metadata: { supabase_user_id: caller.user.id },
    });
    customerId = customer.id;
    await adminClient()
      .from("profiles")
      .update({ stripe_customer_id: customerId })
      .eq("id", caller.user.id);
  }

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: process.env.STRIPE_PRICE_ID!, quantity: 1 }],
    success_url: `${appUrl()}/settings?upgraded=1`,
    cancel_url: `${appUrl()}/settings`,
    // Belt and suspenders for the webhook: the user id rides on the session.
    metadata: { supabase_user_id: caller.user.id },
    subscription_data: {
      metadata: { supabase_user_id: caller.user.id },
    },
  });

  return Response.json({ url: session.url });
}
