// Shared: record a card payment against an invoice. Used by stripe-webhook for
// both pay links: the invoice's own (/i/<token>) and a quote's, whose invoice
// was raised at signing.
//
// record_invoice_payment (the credit notes migration, 115, as replaced by the
// credit allocations migration, 116) does the work in the database, under the
// same lock as issuing a credit note or applying credit, so a payment and a
// credit can never pass each other half way:
//   - a Stripe session already recorded is a repeat delivery and changes nothing
//   - an invoice already paid is left alone (a second tab, or paid by bank)
//   - otherwise the payment is added to amount_paid, and the invoice is paid
//     once the cash plus credit applied to it (amount_allocated) covers what
//     it asks for. Credit applied is a settlement, never cash, so it is not
//     added to amount_paid.
//   - money beyond that (the pay page was open while a credit note was issued
//     or credit was applied to the invoice) becomes credit available on the
//     invoice's newest credit notes, so staff see it on the invoice instead of
//     the money being kept without a word
//
// Until that migration is applied the function is not there, and the payment
// is recorded the way it was before credit notes, so a webhook deployed first
// still records every payment.

import { addPennies, amountAllocated, balanceDue } from "./invoiceEmail.ts";

export type PaymentResult = {
  recorded: boolean;
  reason?: "not_found" | "repeat" | "already_paid";
  invoice_number?: number;
  status?: string;
  amount_paid?: number;
  // Credit applied to the invoice from other invoices' credit notes (116 on).
  amount_allocated?: number;
  balance_due?: number;
  overpaid?: number;
  not_on_a_credit_note?: number;
};

export async function recordInvoicePayment(supabase: any, invoiceId: string, amount: number, sessionId: string | null): Promise<PaymentResult> {
  const { data, error } = await supabase.rpc("record_invoice_payment", {
    p_invoice_id: invoiceId, p_amount: amount, p_session_id: sessionId,
  });
  if (!error) return data as PaymentResult;
  // PGRST202: PostgREST cannot find the function. 42883: Postgres cannot.
  // Anything else is a real failure, thrown so Stripe sends the event again.
  if (error.code !== "PGRST202" && error.code !== "42883") throw new Error(`record_invoice_payment: ${error.message}`);

  // Before the migration. select("*") so a missing amount_credited or
  // amount_allocated column reads as no credit instead of failing.
  const { data: inv, error: readError } = await supabase.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (readError) throw new Error(`invoice read: ${readError.message}`);
  if (!inv) return { recorded: false, reason: "not_found" };
  if (inv.status === "paid") return { recorded: false, reason: "already_paid", invoice_number: inv.invoice_number };
  const amountPaid = addPennies(inv.amount_paid, amount);
  const due = balanceDue({ ...inv, amount_paid: amountPaid });
  const { error: writeError } = await supabase.from("invoices").update(due === 0
    ? { status: "paid", paid_at: new Date().toISOString(), amount_paid: amountPaid }
    : { amount_paid: amountPaid }).eq("id", invoiceId);
  if (writeError) throw new Error(`invoice update: ${writeError.message}`);
  const asked = balanceDue({ ...inv, status: "sent", amount_paid: 0 });
  const overpaid = Math.max(0, addPennies(amountPaid, -asked));
  return {
    recorded: true, invoice_number: inv.invoice_number, status: due === 0 ? "paid" : inv.status,
    amount_paid: amountPaid, amount_allocated: amountAllocated(inv), balance_due: due, overpaid, not_on_a_credit_note: overpaid,
  };
}

// One line in the function log for anything a person may need to act on.
export function logPayment(r: PaymentResult, sessionId: string, amount: number, currency: string) {
  const inv = r.invoice_number != null ? `INV-${r.invoice_number}` : "invoice";
  const took = `${amount.toFixed(2)} ${currency}`;
  if (!r.recorded) {
    if (r.reason === "repeat") console.log(`stripe-webhook: ${inv} already has session ${sessionId}; repeat delivery, not recorded again`);
    else if (r.reason === "already_paid") console.warn(`stripe-webhook: ${inv} is already paid; session ${sessionId} (${took}) not recorded. If it is not a repeat delivery, refund it in Stripe.`);
    else console.error(`stripe-webhook: invoice for session ${sessionId} (${took}) not found; nothing recorded`);
    return;
  }
  if (Number(r.not_on_a_credit_note) > 0) {
    console.error(`stripe-webhook: ${inv} was paid ${Number(r.not_on_a_credit_note).toFixed(2)} ${currency} more than it asks for, and no credit note holds it as a refund owed. Refund it by hand.`);
  } else if (Number(r.overpaid) > 0) {
    console.warn(`stripe-webhook: ${inv} was paid ${Number(r.overpaid).toFixed(2)} ${currency} more than it asks for (a credit note was issued, or credit applied, while the customer paid); it is recorded as credit available on its credit notes.`);
  }
}
