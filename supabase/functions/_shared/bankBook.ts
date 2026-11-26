// Booking bank lines that need a server (notifications, rules that run by
// themselves after a sync).
//
// Company card spend (Peter, 25 Nov 2026: "Duncan has the company card he
// uses for fuel ... pays for fuel then adds the receipt later"). The usual
// way (Pleo, Soldo, Xero and QuickBooks all work like this): the card line
// is the payment, and the person who spent it owes a receipt, not a claim.
// So the line becomes a company card expense in that person's name, already
// paid, never reimbursed, and they are told to attach the receipt. HMRC only
// lets the VAT be reclaimed once a valid VAT receipt is held, which is what
// the receipt step is for. The expense then goes through the normal
// submit and approve flow.

type Obj = Record<string, any>;
const r2 = (n: unknown) => Math.round(Number(n || 0) * 100) / 100;

export function normalizePayee(s: unknown): string {
  return String(s || "").toUpperCase()
    .replace(/\b(LTD|LIMITED|PLC|UK|GBP|CARD PAYMENT|CARD|PAYMENT|DD|BGC|FPS|VISA|MASTERCARD|AMEX|CONTACTLESS)\b/g, " ")
    .replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const gbp = (n: number) => `£${Math.abs(n).toFixed(2)}`;

export async function companyCardExpense(admin: any, txn: Obj, personId: string, categoryId: string | null, actorId: string | null): Promise<string> {
  if (Number(txn.amount) >= 0) throw new Error("Only money going out can be card spend.");
  if (txn.reconciled) throw new Error("That line is already booked.");
  const gross = r2(Math.abs(Number(txn.amount)));
  const what = txn.payee || txn.description || "Card payment";
  const { data: exp, error } = await admin.from("expenses").insert({
    type: "staff_claim", submitter_id: personId, reimburse_to_user_id: personId,
    category_id: categoryId, cost_context: "ongoing", expense_date: txn.booking_date,
    description: what, currency: txn.currency || "GBP", subtotal: gross, tax_amount: 0, total: gross,
    status: "draft", paid_by: "company_card", paid_at: txn.booking_date, payment_method: "company_card",
    payment_reference: txn.dedup_key, notes: "Paid on the company card. Attach the receipt and submit.",
    created_by: actorId || personId,
  }).select("id").single();
  if (error) throw new Error(`expense: ${error.message}`);
  await admin.from("bank_transactions").update({
    reconciled: true, matched_type: "expense", matched_id: exp.id, assigned_to: personId, category_id: categoryId,
  }).eq("id", txn.id);
  await admin.from("notifications").insert({
    recipient_id: personId, actor_id: actorId, type: "assignment",
    title: `Receipt needed: ${what} ${gbp(Number(txn.amount))}`,
    body: `Company card, ${txn.booking_date}. Open the expense, attach the receipt and submit it.`,
    entity_type: "expense", link_id: exp.id,
  });
  return exp.id;
}

export async function paidBillFromLine(admin: any, txn: Obj, fields: { supplier_id?: string | null; category_id?: string | null; cost_context?: string }, actorId: string | null): Promise<string> {
  if (Number(txn.amount) >= 0) throw new Error("Only money going out can be a bill.");
  const gross = r2(Math.abs(Number(txn.amount)));
  const what = txn.payee || txn.description || "Bank payment";
  const { data: bill, error } = await admin.from("bills").insert({
    supplier_id: fields.supplier_id || null, category_id: fields.category_id || null, cost_context: fields.cost_context || "ongoing",
    status: "paid", description: what, currency: txn.currency || "GBP", issue_date: txn.booking_date,
    subtotal: gross, tax_amount: 0, total: gross, amounts_inclusive: true,
    amount_paid: gross, paid_at: txn.booking_date, payment_method: "bank", payment_reference: txn.dedup_key,
    created_by: actorId,
  }).select("id").single();
  if (error) throw new Error(`bill: ${error.message}`);
  await admin.from("bill_line_items").insert({
    bill_id: bill.id, name: what, description: txn.description && txn.description !== what ? txn.description : null,
    qty: 1, unit_price: gross, tax_rate: 0, category_id: fields.category_id || null, line_total: gross, sort: 0,
  });
  await admin.from("bank_transactions").update({ reconciled: true, matched_type: "bill", matched_id: bill.id, category_id: fields.category_id || null }).eq("id", txn.id);
  return bill.id;
}

/** Rules set to "do it automatically": a payee that always becomes a bill, or
 *  card spend that always goes to the same person (fuel to Duncan). */
export async function applyAutoRules(admin: any): Promise<number> {
  const { data: rules } = await admin.from("bank_match_rules").select("*").eq("auto", true);
  if (!rules?.length) return 0;
  const { data: txns } = await admin.from("bank_transactions").select("*").eq("reconciled", false).lt("amount", 0).limit(500);
  let done = 0;
  for (const t of txns || []) {
    const payee = normalizePayee(t.payee || t.description);
    const rule = rules.find((r: Obj) => { const p = normalizePayee(r.payee_pattern); return p && payee.includes(p); });
    if (!rule) continue;
    try {
      if (rule.create_as === "expense" && rule.assign_to) await companyCardExpense(admin, t, rule.assign_to, rule.category_id, rule.created_by);
      else if (rule.create_as === "bill") await paidBillFromLine(admin, t, rule, rule.created_by);
      else continue;
      done++;
    } catch { /* leave the line for a person */ }
  }
  return done;
}
