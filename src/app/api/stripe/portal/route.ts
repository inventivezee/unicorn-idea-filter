// Stripe Billing Portal — manage / cancel the subscription.
import { appUrl, stripe, stripeConfigured } from "@/lib/stripe";
import { cloudConfigured, resolveCaller } from "@/lib/supabase/server";

export async function POST() {
  if (!cloudConfigured() || !stripeConfigured()) {
    return Response.json(
      { error: "Billing is not configured on this deployment." },
      { status: 503 },
    );
  }
  const caller = await resolveCaller();
  if (!caller.user || !caller.profile?.stripe_customer_id) {
    return Response.json(
      { error: "No billing profile found — subscribe first." },
      { status: 400 },
    );
  }
  const session = await stripe().billingPortal.sessions.create({
    customer: caller.profile.stripe_customer_id,
    return_url: `${appUrl()}/settings`,
  });
  return Response.json({ url: session.url });
}
