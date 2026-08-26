// Creates a Stripe Checkout Session for a quote's one-off amount (full or
// deposit). Returns { url } to redirect the customer to. No auth (public quote).
//
// Required secret: STRIPE_SECRET_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Prefer the in-app connected key; fall back to an env secret
    const { data: conn } = await supabase.from("stripe_connection").select("secret_key").eq("id", 1).maybeSingle();
    const stripeKey = conn?.secret_key || Deno.env.get("STRIPE_SECRET_KEY");
    if (!stripeKey) return json({ error: "Stripe is not connected yet." }, 503);
    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
    const { token, origin } = await req.json();
    if (!token) return json({ error: "Missing token" }, 400);

    const { data: quote } = await supabase.from("quotes").select("*").eq("public_token", token).maybeSingle();
    if (!quote) return json({ error: "Quote not found" }, 404);

    // Amount to capture (full one-off, or deposit %)
    let amount = Number(quote.one_off_total) || 0;
    let label = `Quote #${quote.quote_number}`;
    if (quote.payment_terms === "deposit" && quote.deposit_percent > 0) {
      amount = amount * Number(quote.deposit_percent) / 100;
      label += ` — ${quote.deposit_percent}% deposit`;
    }
    if (amount <= 0) return json({ error: "Nothing to charge on this quote." }, 400);

    const base = origin || new URL(req.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: { currency: (quote.currency || "GBP").toLowerCase(), unit_amount: Math.round(amount * 100), product_data: { name: label } },
      }],
      success_url: `${base}/q/${token}?paid=1`,
      cancel_url: `${base}/q/${token}`,
      metadata: { quote_id: quote.id, quote_token: token },
    });

    await supabase.from("quotes").update({ stripe_checkout_id: session.id }).eq("id", quote.id);
    return json({ url: session.url });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
