// Adyen standard webhook: the only thing that marks a card payment received.
//
// The browser coming back from the payment page proves nothing (the customer
// can close the tab, and a failed page looks the same), so the money is
// recorded here and only here, through record_invoice_payment, the same
// database function the Stripe webhook used. The ledger, the locking and the
// credit note handling do not change: only the front door does.
//
// Deployed with verify_jwt = false. Adyen cannot send a Supabase JWT, and with
// the default on, every delivery 401s and Adyen marks the endpoint failing.
//
// THE RULE THIS FILE LIVES BY: never answer 2xx for a notification we have not
// finished with. Adyen retries a non-2xx for days, and a retry is safe because
// record_invoice_payment refuses a pspReference it has already recorded. A 200
// is final: anything we drop after sending one is money nobody ever sees.
//
// Secrets: ADYEN_HMAC_KEY (+ ADYEN_HMAC_KEY_PREV while rotating),
//          ADYEN_WEBHOOK_USER / ADYEN_WEBHOOK_PASSWORD,
//          ADYEN_ENV, ADYEN_MERCHANT_ACCOUNT.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyItem, decide, isTrue, sameString } from "../_shared/adyenWebhook.ts";
import { recordInvoicePayment, logPayment } from "../_shared/invoicePayment.ts";

const accepted = () => new Response("[accepted]", { status: 200, headers: { "Content-Type": "text/plain" } });
const retry = (why: string, status = 503) => new Response(why, { status });

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  // Basic auth fails CLOSED. Half a credential (one secret set, the other
  // blank) used to skip the check entirely and leave the public url open.
  const user = Deno.env.get("ADYEN_WEBHOOK_USER") || "";
  const pass = Deno.env.get("ADYEN_WEBHOOK_PASSWORD") || "";
  if ((user === "") !== (pass === "")) {
    console.error("adyen-webhook: only one half of the basic auth credential is set");
    return retry("webhook auth is misconfigured");
  }
  if (user && pass && !sameString(req.headers.get("authorization") || "", "Basic " + btoa(`${user}:${pass}`))) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  // `live` is the STRING "true"/"false": Boolean("false") is true.
  const live = isTrue(body?.live);
  const env = (Deno.env.get("ADYEN_ENV") || "test").toLowerCase();
  const ourMerchant = Deno.env.get("ADYEN_MERCHANT_ACCOUNT") || "";
  const keys = [Deno.env.get("ADYEN_HMAC_KEY"), Deno.env.get("ADYEN_HMAC_KEY_PREV")].filter(Boolean) as string[];

  // A live notification with no key configured is OUR gap, not a forgery. 503
  // keeps Adyen retrying so the payment lands once the secret is set; a 401
  // would tell Adyen we reject it and the money would go unrecorded.
  if (live && !keys.length) {
    console.error("adyen-webhook: live notification refused, ADYEN_HMAC_KEY is not set");
    return retry("hmac key not configured");
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const items = (Array.isArray(body?.notificationItems) ? body.notificationItems : [])
    .map((w: any) => w?.NotificationRequestItem || w).filter(Boolean);

  for (const item of items) {
    const psp = String(item?.pspReference || "");
    const code = String(item?.eventCode || "");

    if (!(await verifyItem(item, keys))) {
      // NOT an ack. A wrong or half-rotated key must not cost us the payment:
      // Adyen keeps this in its queue for days while the key is put right.
      console.error(`adyen-webhook: signature did not verify for ${code} ${psp}`);
      await mark(supabase, item, live, "signature_failed", null);
      return retry("signature did not verify");
    }

    // The notification has to be from the account we are actually watching,
    // in the environment we are actually in: a test notification must never
    // mark a live invoice paid.
    if (live !== (env === "live")) {
      console.error(`adyen-webhook: ${live ? "live" : "test"} notification while ADYEN_ENV is ${env}; ignored`);
      await mark(supabase, item, live, "wrong_environment", { ignored: true });
      continue;
    }
    if (ourMerchant && String(item?.merchantAccountCode || "") !== ourMerchant) {
      console.error(`adyen-webhook: notification for ${item?.merchantAccountCode}, not ${ourMerchant}; ignored`);
      await mark(supabase, item, live, "wrong_merchant", { ignored: true });
      continue;
    }

    // Claim it. The row is a CLAIM, not a tombstone: an existing row that was
    // never finished (handled_at null) is picked up again, because the money
    // not landing is worse than doing the work twice, and doing it twice is
    // already safe (record_invoice_payment refuses a pspReference it holds).
    const claim = await claimEvent(supabase, item, live);
    if (claim === "done") { console.log(`adyen-webhook: ${code} ${psp} already handled; repeat delivery`); continue; }

    const d = decide(item);

    if (d.action === "ignore") {
      console.log(`adyen-webhook: ${d.why}`);
      await finish(supabase, psp, code, { ignored: d.why });
      continue;
    }

    if (d.action === "note") {
      await noteOnInvoice(supabase, item, d.note);
      await finish(supabase, psp, code, { noted: d.note });
      continue;
    }

    // Money. Check the currency the way the Stripe webhook did: a payment in
    // the wrong currency is recorded NOWHERE and shouted about, because the
    // amount would otherwise be added to a different currency's invoice.
    const { data: inv } = await supabase.from("invoices")
      .select("id, invoice_number, currency, notes, quote_id").eq("id", d.invoiceId).maybeSingle();
    if (!inv) {
      console.error(`adyen-webhook: no invoice ${d.invoiceId} for ${psp}; nothing recorded`);
      await finish(supabase, psp, code, { error: "invoice not found" });
      continue;
    }
    const want = String(inv.currency || "GBP").toUpperCase();
    if (want !== d.currency.toUpperCase()) {
      const note = `⚠ PAYMENT NEEDS MANUAL RECONCILING: ${d.amount.toFixed(2)} ${d.currency} taken on Adyen (${psp}) against an invoice in ${want}.`;
      if (!String(inv.notes || "").includes(psp)) {
        await supabase.from("invoices").update({ notes: `${inv.notes ? inv.notes + "\n" : ""}${note}` }).eq("id", inv.id);
      }
      console.error(`adyen-webhook: ${note}`);
      // Deliberately a retry: the red webhook in the Customer Area is the point.
      return retry("currency does not match the invoice", 500);
    }

    try {
      // pspReference is the idempotency key: unique per payment, and stable
      // across Adyen's repeat deliveries of the same event.
      const r = await recordInvoicePayment(supabase, d.invoiceId, d.amount, d.psp);
      logPayment(r, d.psp, d.amount, d.currency);
      await finish(supabase, psp, code, r as unknown as Record<string, unknown>);
      if (r.recorded) await stampQuote(supabase, inv, r);
    } catch (e) {
      // Leave the claim unfinished so the retry picks it up, and never ack.
      console.error(`adyen-webhook: recording ${psp} failed: ${(e as Error).message}`);
      return retry("not recorded", 500);
    }
  }

  return accepted();
});

/** Write an event down without claiming it (refusals and misroutes). */
async function mark(supabase: any, item: any, live: boolean, state: string, result: Record<string, unknown> | null) {
  const { error } = await supabase.from("adyen_events").upsert({
    psp_reference: String(item?.pspReference || ""), event_code: String(item?.eventCode || ""),
    merchant_reference: item?.merchantReference || null, success: isTrue(item?.success),
    live, state, payload: item, result, handled_at: result ? new Date().toISOString() : null,
  }, { onConflict: "psp_reference,event_code", ignoreDuplicates: true });
  if (error) console.error(`adyen-webhook: could not write the event down: ${error.message}`);
}

/**
 * "fresh" when this notification still needs doing (new, or claimed before and
 * never finished), "done" when it was already handled through to the end.
 */
async function claimEvent(supabase: any, item: any, live: boolean): Promise<"fresh" | "done"> {
  const psp = String(item?.pspReference || "");
  const code = String(item?.eventCode || "");
  const { error } = await supabase.from("adyen_events").upsert({
    psp_reference: psp, event_code: code, merchant_reference: item?.merchantReference || null,
    success: isTrue(item?.success), live, state: "received", payload: item,
  }, { onConflict: "psp_reference,event_code", ignoreDuplicates: true });
  if (error) {
    // Bookkeeping must never stop a payment; worst case we do the work again,
    // and record_invoice_payment refuses the second one.
    console.error(`adyen-webhook: could not claim ${code} ${psp}: ${error.message}`);
    return "fresh";
  }
  const { data: row } = await supabase.from("adyen_events")
    .select("handled_at, state").eq("psp_reference", psp).eq("event_code", code).maybeSingle();
  // Only a FINISHED row stops us. signature_failed is never finished.
  return row?.handled_at ? "done" : "fresh";
}

const finish = (supabase: any, psp: string, code: string, result: Record<string, unknown>) =>
  supabase.from("adyen_events")
    .update({ handled_at: new Date().toISOString(), state: "handled", result })
    .eq("psp_reference", psp).eq("event_code", code);

/**
 * A paid quote should say so. The Stripe webhook stamped the quote as well as
 * the invoice, and the public quote page reads those columns to decide whether
 * it still owes money.
 */
async function stampQuote(supabase: any, inv: any, r: any) {
  if (!inv?.quote_id) return;
  const patch: Record<string, unknown> = { amount_paid: r.amount_paid ?? null };
  // Paid only when the invoice itself is settled: a deposit is not a paid quote.
  if (String(r.status) === "paid") { patch.status = "paid"; patch.paid_at = new Date().toISOString(); }
  const { error } = await supabase.from("quotes").update(patch).eq("id", inv.quote_id);
  if (error) console.error(`adyen-webhook: quote ${inv.quote_id} not stamped: ${error.message}`);
}

/** A line on the invoice's timeline for the things that are not money. */
async function noteOnInvoice(supabase: any, item: any, note: string) {
  const ref = String(item?.merchantReference || "");
  const id = /^inv-([0-9a-f-]{36})$/i.exec(ref)?.[1];
  if (!id) { console.log(`adyen-webhook: ${note} (no invoice on ${ref})`); return; }
  const { data: inv } = await supabase.from("invoices").select("id, invoice_number").eq("id", id).maybeSingle();
  if (!inv) return;
  await supabase.from("crm_activities").insert({
    type: "note", subject_type: "invoice", subject_id: inv.id, direction: "inbound", is_internal: true,
    body: `Card payment: ${note}`,
    channel_metadata: { adyen: true, psp_reference: item?.pspReference, event_code: item?.eventCode },
  });
  console.log(`adyen-webhook: INV-${inv.invoice_number}: ${note}`);
}
