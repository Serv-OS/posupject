// Stripe webhook: on checkout.session.completed, mark the quote paid and
// execute it (close the deal -> create onboarding).
//
// Required secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { invoiceEmailHtml, sendInvoiceEmail, moneyFor } from "../_shared/invoiceEmail.ts";
import { ensureInvoiceForQuote, quoteContactEmail } from "../_shared/quoteInvoice.ts";

// Quote paid -> find the invoice raised at signing (or create it now) and mark
// it paid in full, or record a deposit against it. Then email the receipt.
async function createPaidInvoiceForQuote(supabase: any, quoteId: string, paidAmount: number) {
  const { data: q } = await supabase.from("quotes").select("*").eq("id", quoteId).maybeSingle();
  if (!q) return;

  let inv = await ensureInvoiceForQuote(supabase, q);
  const now = new Date().toISOString();
  const fullPayment = paidAmount >= Number(q.one_off_total || 0) - 0.01;

  if (inv) {
    const alreadyPaid = Number(inv.amount_paid || 0);
    const patch = fullPayment || alreadyPaid + paidAmount >= Number(inv.total || 0) - 0.01
      ? { status: "paid", paid_at: now, amount_paid: alreadyPaid + paidAmount }
      : { amount_paid: alreadyPaid + paidAmount,
          notes: `${inv.notes ? inv.notes + "\n" : ""}Deposit of ${moneyFor(q.currency)(paidAmount)} received ${now.slice(0, 10)}. Balance to follow.` };
    await supabase.from("invoices").update(patch).eq("id", inv.id);
    inv = { ...inv, ...patch };
  } else {
    // Quote with no one-off value (shouldn't happen for a payment) — receipt-only invoice
    const today = now.slice(0, 10);
    const { data: created, error } = await supabase.from("invoices").insert({
      quote_id: q.id, company_id: q.company_id, location_id: q.location_id, contact_id: q.contact_id,
      currency: q.currency || "GBP",
      status: "paid", issue_date: today, due_date: today,
      subtotal: paidAmount, tax_amount: 0, total: paidAmount,
      paid_at: now, amount_paid: paidAmount,
      notes: `Payment received for quote Q-${q.quote_number}.`, created_by: q.created_by,
    }).select().single();
    if (error || !created) return;
    await supabase.from("invoice_line_items").insert({
      invoice_id: created.id, name: `Payment on quote Q-${q.quote_number}`,
      description: q.deposit_percent ? `${q.deposit_percent}% deposit` : null,
      qty: 1, unit_price: paidAmount, tax_rate: 0, sort: 0,
    });
    inv = created;
  }

  // Email the receipt to the customer (best effort)
  const recipient = inv.email_to || await quoteContactEmail(supabase, q);
  if (recipient) {
    const { data: seller } = await supabase.from("support_settings")
      .select("business_name, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle();
    const appUrl = Deno.env.get("APP_URL") || "https://posupject.vercel.app";
    const { subject, html } = invoiceEmailHtml(inv, seller || {}, `${appUrl}/i/${inv.public_token}`, { paid: inv.status === "paid" });
    await sendInvoiceEmail(supabase, recipient, subject, html);
    await supabase.from("invoices").update({ sent_at: new Date().toISOString(), email_to: recipient }).eq("id", inv.id);
  }
}

serve(async (req) => {
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: conn } = await supabase.from("stripe_connection").select("secret_key, webhook_secret").eq("id", 1).maybeSingle();
  const stripeKey = conn?.secret_key || Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = conn?.webhook_secret || Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeKey || !webhookSecret) return new Response("Stripe not configured", { status: 503 });

  const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });

  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig!, webhookSecret, undefined, Stripe.createSubtleCryptoProvider());
  } catch (e) {
    return new Response(`Webhook signature failed: ${(e as Error).message}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    // A $500 session must never mark a £500 document paid. The checkout
    // functions now set the session currency FROM the document, so a mismatch
    // means something is genuinely wrong — record nothing automatically and
    // shout, so the money is reconciled by a person, not a guess.
    const sessionCurrency = String(session.currency || "gbp").toUpperCase();
    let mismatch = false;
    const currencyMatches = async (table: string, id: string) => {
      const { data } = await supabase.from(table).select("currency, notes, stripe_payment_intent").eq("id", id).maybeSingle();
      const docCurrency = (data?.currency || "GBP").toUpperCase();
      if (docCurrency !== sessionCurrency) {
        // The card HAS been charged. Recording nothing and acking 200 would
        // bury a captured payment in unread logs — leave a durable trace on
        // the document (idempotent on the session id) without touching its
        // status or amounts, then fail the webhook so Stripe retries and its
        // failed-webhook alerting stays red until a person reconciles.
        console.error(`stripe-webhook: CURRENCY MISMATCH on ${table} ${id}: session ${sessionCurrency} vs document ${docCurrency} — not auto-reconciling`);
        mismatch = true;
        const already = String(data?.notes || "").includes(session.id);
        if (!already) {
          const note = `⚠ PAYMENT NEEDS MANUAL RECONCILING: Stripe took ${((session.amount_total || 0) / 100).toFixed(2)} ${sessionCurrency} (session ${session.id}, intent ${session.payment_intent || "?"}) but this document is in ${docCurrency}. Status left untouched.`;
          await supabase.from(table).update({
            notes: `${data?.notes ? data.notes + "\n" : ""}${note}`,
            ...(table === "quotes" ? { stripe_payment_intent: session.payment_intent || null } : {}),
          }).eq("id", id);
        }
        return false;
      }
      return true;
    };
    const quoteId = session.metadata?.quote_id;
    if (quoteId && await currencyMatches("quotes", quoteId)) {
      await supabase.from("quotes").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        amount_paid: (session.amount_total || 0) / 100,
        stripe_payment_intent: session.payment_intent || null,
      }).eq("id", quoteId);
      // Close the deal + create onboarding
      await supabase.rpc("execute_quote", { p_quote_id: quoteId });
      // Generate a PAID invoice (receipt) for the payment and email it
      try {
        await createPaidInvoiceForQuote(supabase, quoteId, (session.amount_total || 0) / 100);
      } catch (e) {
        console.error("receipt invoice failed:", (e as Error).message);
      }
    }
    // Invoice payments (one-off + recurring)
    const invoiceId = session.metadata?.invoice_id;
    if (invoiceId && await currencyMatches("invoices", invoiceId)) {
      await supabase.from("invoices").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        amount_paid: (session.amount_total || 0) / 100,
      }).eq("id", invoiceId);
    }
  }

  // A mismatch is a failure: Stripe keeps retrying and flags the endpoint,
  // which is exactly the alarm a mis-currencied captured payment deserves.
  if (mismatch) return new Response("currency mismatch — manual reconciliation required", { status: 500 });
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
