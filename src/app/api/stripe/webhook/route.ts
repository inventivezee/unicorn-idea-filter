// Stripe webhook — the single source of truth for subscription state.
// Configure the endpoint in Stripe for: checkout.session.completed,
// customer.subscription.updated, customer.subscription.deleted.
import type Stripe from "stripe";
import { stripe, stripeConfigured } from "@/lib/stripe";
import { adminClient, cloudConfigured } from "@/lib/supabase/server";

function mapStatus(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "none";
  }
}

async function applySubscription(sub: Stripe.Subscription): Promise<void> {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const periodEnd = sub.items.data[0]?.current_period_end;
  const update = {
    subscription_status: mapStatus(sub.status),
    subscription_period_end: periodEnd
      ? new Date(periodEnd * 1000).toISOString()
      : null,
  };
  const admin = adminClient();
  const { data } = await admin
    .from("profiles")
    .update(update)
    .eq("stripe_customer_id", customerId)
    .select("id");
  if (!data?.length) {
    // Fallback: match by the user id we stamped into subscription metadata.
    const userId = sub.metadata?.supabase_user_id;
    if (userId) {
      await admin
        .from("profiles")
        .update({ ...update, stripe_customer_id: customerId })
        .eq("id", userId);
    }
  }
}

export async function POST(request: Request) {
  if (!cloudConfigured() || !stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    return Response.json({ error: "Billing not configured." }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "Missing signature." }, { status: 400 });
  }
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return Response.json({ error: "Invalid signature." }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const sub = await stripe().subscriptions.retrieve(
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id,
        );
        await applySubscription(sub);
      }
      break;
    }
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await applySubscription(event.data.object);
      break;
    }
    default:
      // Unhandled event types are acknowledged so Stripe stops retrying.
      break;
  }

  return Response.json({ received: true });
}
