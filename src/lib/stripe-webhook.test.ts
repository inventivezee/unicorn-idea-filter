// Offline verification of the Stripe webhook signature path: constructs a
// payload signed exactly the way Stripe signs deliveries (t=…,v1=HMAC-SHA256)
// and checks the SDK accepts it — and rejects tampering. This pins the
// contract the /api/stripe/webhook route relies on.
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";

const SECRET = "whsec_test_secret_for_offline_verification";
const stripe = new Stripe("sk_test_dummy_key_never_used_for_requests");

function sign(payload: string, secret: string, timestamp: number): string {
  // Stripe HMACs with the secret string verbatim (whsec_ prefix included).
  const mac = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

const EVENT = JSON.stringify({
  id: "evt_test_1",
  object: "event",
  type: "customer.subscription.updated",
  data: {
    object: {
      id: "sub_test_1",
      object: "subscription",
      status: "active",
      customer: "cus_test_1",
      metadata: { supabase_user_id: "user-1" },
      items: { data: [{ current_period_end: 1783200000 }] },
    },
  },
});

describe("stripe webhook signature contract", () => {
  it("accepts a correctly signed payload", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const event = await stripe.webhooks.constructEventAsync(
      EVENT,
      sign(EVENT, SECRET, ts),
      SECRET,
    );
    expect(event.type).toBe("customer.subscription.updated");
    const sub = event.data.object as Stripe.Subscription;
    expect(sub.status).toBe("active");
    expect(sub.customer).toBe("cus_test_1");
    expect(sub.items.data[0]?.current_period_end).toBe(1783200000);
  });

  it("rejects a tampered payload", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const signature = sign(EVENT, SECRET, ts);
    const tampered = EVENT.replace("active", "canceled");
    await expect(
      stripe.webhooks.constructEventAsync(tampered, signature, SECRET),
    ).rejects.toThrow();
  });

  it("rejects a stale timestamp", async () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    await expect(
      stripe.webhooks.constructEventAsync(EVENT, sign(EVENT, SECRET, stale), SECRET),
    ).rejects.toThrow();
  });
});
