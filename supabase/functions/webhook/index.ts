// ViralGuideAI – Lemon Squeezy Webhook Edge Function
// supabase/functions/webhook/index.ts
//
// Required environment variables (set in Supabase Dashboard → Edge Functions → Secrets):
//   LEMON_SQUEEZY_WEBHOOK_SECRET  – the signing secret from your LS webhook settings
//   SUPABASE_URL                  – auto-injected by Supabase
//   SUPABASE_SERVICE_ROLE_KEY     – auto-injected by Supabase

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CREDIT_MAP: Record<string, number> = {
  starter: 150,
  pro:     500,
  growth:  99999,
};

// Map Lemon Squeezy product/variant names (lowercased) to plan tiers.
// Adjust these to match your actual LS product names.
function resolvePlanTier(productName: string): string | null {
  const name = productName.toLowerCase();
  if (name.includes("growth"))  return "growth";
  if (name.includes("pro"))     return "pro";
  if (name.includes("starter")) return "starter";
  return null;
}

async function verifySignature(secret: string, rawBody: string, signature: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  // Lemon Squeezy sends the signature as a hex string
  const sigBytes = new Uint8Array(
    signature.match(/.{1,2}/g)!.map(b => parseInt(b, 16))
  );

  return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(rawBody));
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ── 1. Read raw body (needed for HMAC verification) ─────────────────────
  const rawBody = await req.text();

  // ── 2. Verify cryptographic signature ───────────────────────────────────
  const secret    = Deno.env.get("LEMON_SQUEEZY_WEBHOOK_SECRET");
  const signature = req.headers.get("X-Signature");

  if (!secret || !signature) {
    return new Response("Unauthorized", { status: 401 });
  }

  const valid = await verifySignature(secret, rawBody, signature);
  if (!valid) {
    console.error("Webhook signature verification failed.");
    return new Response("Forbidden", { status: 403 });
  }

  // ── 3. Parse event ───────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const eventName = payload.meta?.event_name as string | undefined;

  if (eventName !== "subscription_created" && eventName !== "subscription_updated") {
    // Acknowledge but ignore other events
    return new Response("OK", { status: 200 });
  }

  const attrs       = (payload.data as Record<string, unknown>)?.attributes as Record<string, unknown>;
  const userEmail   = attrs?.user_email as string | undefined;
  const productName = attrs?.product_name as string | undefined;
  const status      = attrs?.status as string | undefined;

  if (!userEmail || !productName) {
    console.error("Missing user_email or product_name in payload.");
    return new Response("Bad Request", { status: 400 });
  }

  // ── 4. Resolve plan ──────────────────────────────────────────────────────
  let planTier: string;
  let credits: number;

  if (status === "cancelled" || status === "expired") {
    // Downgrade to free on cancellation
    planTier = "free";
    credits  = 0;
  } else {
    const resolved = resolvePlanTier(productName);
    if (!resolved) {
      console.error(`Unknown product name: ${productName}`);
      return new Response("Unprocessable Entity", { status: 422 });
    }
    planTier = resolved;
    credits  = CREDIT_MAP[planTier];
  }

  // ── 5. Update database ───────────────────────────────────────────────────
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { error } = await supabase
    .from("users")
    .update({
      plan_tier:       planTier,
      monthly_credits: credits,
    })
    .eq("email", userEmail);

  if (error) {
    console.error("Supabase update error:", error.message);
    return new Response("Internal Server Error", { status: 500 });
  }

  console.log(`Updated ${userEmail} → plan=${planTier}, credits=${credits}`);
  return new Response("OK", { status: 200 });
});
