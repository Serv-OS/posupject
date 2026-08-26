// Creates a Stripe Checkout Session for an invoice. Called from the public
// invoice page (/i/<token>), so no JWT — the unguessable token is the auth.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=denonext";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const { token, origin } = await req.json();
    if (!token) return json({ error: "Missing token" }, 400);

    const { data: inv } = await supabase.from("invoices").select("*").eq("public_token", token).maybeSingle();
    if (!inv || inv.status === "void") return json({ error: "Invoice not found" }, 404);
    if (inv.status === "paid") return json({ error: "This invoice is already paid." }, 400);

    const { data: conn } = await supabase.from("stripe_connection").select("secret_key").eq("id", 1).maybeSingle();
    if (!conn?.secret_key) return json({ error: "Payments are not configured." }, 400);
    const stripe = new Stripe(conn.secret_key, { apiVersion: "2023-10-16" });

    const amount = Number(inv.total) || 0;
    if (amount <= 0) return json({ error: "Nothing to charge on this invoice." }, 400);

    const base = origin || new URL(req.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: { currency: (inv.currency || "GBP").toLowerCase(), unit_amount: Math.round(amount * 100), product_data: { name: `Invoice INV-${inv.invoice_number}` } },
      }],
      success_url: `${base}/i/${token}?paid=1`,
      cancel_url: `${base}/i/${token}`,
      metadata: { invoice_id: inv.id },
    });

    await supabase.from("invoices").update({ stripe_checkout_id: session.id }).eq("id", inv.id);
    return json({ url: session.url });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
