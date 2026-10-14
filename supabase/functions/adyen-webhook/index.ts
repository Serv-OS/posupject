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
// Secrets: ADYEN_HMAC_KEY (+ ADYEN_HMAC_KEY_PREV while rotating),
//          ADYEN_WEBHOOK_USER / ADYEN_WEBHOOK_PASSWORD, ADYEN_ENV.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyItem, decide, isTrue } from "../_shared/adyenWebhook.ts";
import { recordInvoicePayment, logPayment } from "../_shared/invoicePayment.ts";

// Adyen accepts on the status code; the body is the older convention and is
// harmless. Anything other than a 2xx means Adyen retries, for days.
const accepted = () => new Response("[accepted]", { status: 200, headers: { "Content-Type": "text/plain" } });

serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const user = Deno.env.get("ADYEN_WEBHOOK_USER");
  const pass = Deno.env.get("ADYEN_WEBHOOK_PASSWORD");
  if (user && pass) {
    const got = req.headers.get("authorization") || "";
    if (got !== "Basic " + btoa(`${user}:${pass}`)) return new Response("unauthorized", { status: 401 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("bad json", { status: 400 }); }

  // `live` is the STRING "true"/"false": Boolean("false") is true.
  const live = isTrue(body?.live);
  const keys = [Deno.env.get("ADYEN_HMAC_KEY"), Deno.env.get("ADYEN_HMAC_KEY_PREV")].filter(Boolean) as string[];

  // A live notification with no key configured is OUR gap, not a forgery. 503
  // keeps Adyen retrying so the payment lands once the secret is set; a 401
  // would tell Adyen we reject it and the money would go unrecorded.
  if (live && !keys.length) {
    console.error("adyen-webhook: live notification refused, ADYEN_HMAC_KEY is not set");
    return new Response("hmac key not configured", { status: 503 });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const items = Array.isArray(body?.notificationItems) ? body.notificationItems : [];

  for (const wrapper of items) {
    const item = wrapper?.NotificationRequestItem || wrapper;
    if (!item) continue;

    if (!(await verifyItem(item, keys))) {
      // Never act on it, but never lose it either: Adyen retries for days and
      // a signature that never verifies is something a person must look at.
      console.error(`adyen-webhook: signature did not verify for ${item?.eventCode} ${item?.pspReference}`);
      await audit(supabase, item, live, "signature_failed");
      continue;
    }

    // Every verified item is written down before anything is decided, so the
    // trail exists even for the ones we do nothing with.
    const fresh = await audit(supabase, item, live, "received");
    if (!fresh) {
      console.log(`adyen-webhook: ${item.eventCode} ${item.pspReference} already handled; repeat delivery`);
      continue;
    }

    const d = decide(item);
    if (d.action === "ignore") { console.log(`adyen-webhook: ${d.why}`); continue; }

    if (d.action === "note") {
      await noteOnInvoice(supabase, item, d.note);
      continue;
    }

    try {
      // pspReference is the idempotency key: unique per payment, and stable
      // across Adyen's repeat deliveries of the same event.
      const r = await recordInvoicePayment(supabase, d.invoiceId, d.amount, d.psp);
      logPayment(r, d.psp, d.amount, d.currency);
      await supabase.from("adyen_events")
        .update({ handled_at: new Date().toISOString(), result: r as unknown as Record<string, unknown> })
        .eq("psp_reference", d.psp).eq("event_code", item.eventCode);
    } catch (e) {
      // Throwing here would lose the payment: answer 500 so Adyen sends it again.
      console.error(`adyen-webhook: recording ${d.psp} failed: ${(e as Error).message}`);
      return new Response("not recorded", { status: 500 });
    }
  }

  return accepted();
});

/** Write the notification down. Returns false when we have seen it before. */
async function audit(supabase: any, item: any, live: boolean, state: string): Promise<boolean> {
  const { error } = await supabase.from("adyen_events").insert({
    psp_reference: String(item?.pspReference || ""),
    event_code: String(item?.eventCode || ""),
    merchant_reference: item?.merchantReference || null,
    success: isTrue(item?.success),
    live,
    state,
    payload: item,
  });
  if (!error) return true;
  if (error.code === "23505") return false;           // seen before: the unique index did its job
  console.error(`adyen-webhook: could not write the event down: ${error.message}`);
  return true;                                         // never let bookkeeping stop a payment
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
