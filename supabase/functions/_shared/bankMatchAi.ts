// The bank feed's AI matcher (Peter, 25 Nov 2026: "there should also be an
// agent that is figuring out the likely match").
//
// For each unmatched bank line it reads the open invoices, bills, approved
// expenses and the other unmatched lines (for refunds), and stores its best
// guess on bank_transactions.ai_match:
//   { kind, target_id, confidence, reason, person_id?, category_id? }
// kind: invoice | bill | expense | refund | company_card | new_bill | new_invoice | ignore | none
// It only suggests. Nothing is booked until a person presses the button.
// Uses the key and model already saved in ai_settings (the CRM's AI settings).

type Obj = Record<string, any>;
const r2 = (n: unknown) => Math.round(Number(n || 0) * 100) / 100;

const balance = (i: Obj) => r2(Number(i.total || 0) - Number(i.amount_paid || 0) - Number(i.amount_credited || 0) - Number(i.amount_allocated || 0));

const TOOL = {
  name: "record_matches",
  description: "Record the most likely match for each bank line.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            txn_id: { type: "string" },
            kind: { type: "string", enum: ["invoice", "bill", "expense", "refund", "company_card", "new_bill", "new_invoice", "ignore", "none"] },
            target_id: { type: ["string", "null"], description: "id of the invoice, bill, expense or the other bank line (for refund). null for new_*, company_card, ignore, none." },
            confidence: { type: "number", description: "0 to 1" },
            reason: { type: "string", description: "One short sentence a finance person can check, e.g. 'Reference says INV-1021 and the amount equals what is owed.'" },
            person_id: { type: ["string", "null"], description: "For company_card: the team member who most likely made the purchase, if the history shows one." },
            category_id: { type: ["string", "null"], description: "For company_card or new_bill: the expense category id that fits." },
          },
          required: ["txn_id", "kind", "confidence", "reason"],
        },
      },
    },
    required: ["matches"],
  },
};

const SYSTEM = `You reconcile a UK company's business bank account (POSUP, a restaurant till and payments company) against its CRM.
For every bank line, choose the single most likely explanation:
- invoice: money IN that pays one of the open invoices, OR is the payment for an invoice ALREADY MARKED PAID (the second list: staff often mark invoices paid by hand before the bank line is matched; then the bank line just links to it). A reference that is an invoice number, with the same amount, is a very strong sign. Prefer this over new_invoice whenever such an invoice exists. Look for the invoice number in the reference (INV-1021, 1021), the amount equalling what is still owed, and the payer name resembling the customer (a director's personal name or a trading name often differs from the company name).
- bill: money OUT that pays one of the open supplier bills.
- expense: money OUT that reimburses one of the approved staff expenses (payee is usually the staff member).
- refund: this line reverses another bank line (same or very similar amount, opposite sign, same merchant or person, usually within weeks). target_id is the other bank line's id.
- company_card: a card purchase by a team member that needs a receipt raising as an expense (fuel, parking, food on the road, tools). Say who, if earlier lines show a pattern; otherwise person_id null.
- new_bill: a supplier payment or subscription with no bill yet (software, rent, utilities, phone).
- new_invoice: money IN from a customer with no matching invoice.
- ignore: a transfer between the company's own accounts or pots, or anything that needs no booking.
- none: genuinely unclear.
Never invent ids: target_id, person_id and category_id must come from the lists given. Amounts must agree to the penny for invoice, bill and expense unless the reference clearly names the document (then it is a part payment, say so). Be honest about confidence.
The company banks in pounds (UK) and dollars (US). Only match a line to a document or line in the SAME currency.`;

export async function aiMatch(admin: any, opts: { txnIds?: string[]; limit?: number } = {}): Promise<{ checked: number; error?: string }> {
  const { data: cfg } = await admin.from("ai_settings").select("api_key, model, enabled").eq("id", 1).maybeSingle();
  if (!cfg?.enabled || !cfg?.api_key) return { checked: 0, error: "AI is not set up (Settings, AI)." };

  let q = admin.from("bank_transactions").select("id, booking_date, amount, currency, payee, description, status")
    .eq("reconciled", false).order("booking_date", { ascending: false }).limit(opts.limit || 40);
  if (opts.txnIds?.length) q = q.in("id", opts.txnIds);
  else q = q.is("ai_checked_at", null);
  const { data: txns } = await q;
  if (!txns?.length) return { checked: 0 };

  const [inv, bills, exps, people, cats, others, paidInv, linked] = await Promise.all([
    admin.from("invoices").select("*, company:companies(name)").in("status", ["sent", "viewed"]).order("invoice_number", { ascending: false }).limit(200),
    admin.from("bills").select("id, bill_number, total, amount_paid, currency, due_date, issue_date, description, supplier:inv_suppliers(name)").in("status", ["to_pay", "partially_paid"]).limit(150),
    admin.from("expenses").select("id, expense_number, total, currency, expense_date, description, paid_by, submitter:profiles!expenses_submitter_id_fkey(display_name)").eq("status", "approved").neq("paid_by", "company_card").limit(100),
    admin.from("profiles").select("id, display_name").in("role", ["owner", "editor"]),
    admin.from("expense_categories").select("id, label").eq("active", true),
    admin.from("bank_transactions").select("id, booking_date, amount, currency, payee, description, matched_type, assigned_to").order("booking_date", { ascending: false }).limit(300),
    admin.from("invoices").select("id, invoice_number, total, amount_paid, currency, paid_at, company:companies(name)").eq("status", "paid").order("paid_at", { ascending: false }).limit(400),
    admin.from("bank_transactions").select("matched_id").eq("matched_type", "invoice").not("matched_id", "is", null),
  ]);
  const linkedIds = new Set((linked.data || []).map((x: Obj) => x.matched_id));
  const paidOpen = (paidInv.data || []).filter((i: Obj) => !linkedIds.has(i.id));

  const lines = (rows: Obj[] | null, f: (r: Obj) => string) => (rows || []).map(f).join("\n") || "(none)";
  const prompt = [
    "BANK LINES TO EXPLAIN (id | date | amount, negative = money out | payee | reference):",
    lines(txns, (t) => `${t.id} | ${t.booking_date} | ${r2(t.amount)} ${t.currency || "GBP"} | ${t.payee || ""} | ${t.description || ""}${t.status === "pending" ? " | pending" : ""}`),
    "\nOPEN INVOICES (id | number | customer | still owed | due):",
    lines((inv.data || []).filter((i: Obj) => balance(i) > 0), (i) => `${i.id} | INV-${i.invoice_number} | ${i.company?.name || "?"} | ${balance(i)} ${i.currency || "GBP"} | ${i.due_date || ""}`),
    "\nINVOICES ALREADY MARKED PAID, NOT YET LINKED TO A BANK LINE (id | number | customer | amount paid | marked paid on):",
    lines(paidOpen, (i) => `${i.id} | INV-${i.invoice_number} | ${i.company?.name || "?"} | ${r2(i.amount_paid || i.total)} ${i.currency || "GBP"} | ${String(i.paid_at || "").slice(0, 10)}`),
    "\nOPEN BILLS (id | number | supplier | still owed | due | description):",
    lines(bills.data, (b) => `${b.id} | ${b.bill_number ?? ""} | ${b.supplier?.name || "?"} | ${r2(Number(b.total) - Number(b.amount_paid || 0))} ${b.currency || "GBP"} | ${b.due_date || b.issue_date || ""} | ${b.description || ""}`),
    "\nAPPROVED STAFF EXPENSES TO REIMBURSE (id | number | person | amount | date | description):",
    lines(exps.data, (e) => `${e.id} | ${e.expense_number ?? ""} | ${e.submitter?.display_name || "?"} | ${r2(e.total)} ${e.currency || "GBP"} | ${e.expense_date} | ${e.description || ""}`),
    "\nOTHER RECENT BANK LINES, for refunds and patterns (id | date | amount | payee | reference | how it was booked | assigned person id):",
    lines((others.data || []).filter((o: Obj) => !txns.some((t: Obj) => t.id === o.id)).slice(0, 200), (o) => `${o.id} | ${o.booking_date} | ${r2(o.amount)} ${o.currency || "GBP"} | ${o.payee || ""} | ${o.description || ""} | ${o.matched_type || "unmatched"} | ${o.assigned_to || ""}`),
    "\nTEAM (id | name):",
    lines(people.data, (p) => `${p.id} | ${p.display_name}`),
    "\nEXPENSE CATEGORIES (id | name):",
    lines(cats.data, (c) => `${c.id} | ${c.label}`),
    "\nRecord one match for every bank line in the first list.",
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.api_key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: cfg.model || "claude-opus-5-5",
      max_tokens: 8000,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "record_matches" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { checked: 0, error: `AI: ${j?.error?.message || res.status}` };
  const use = (j.content || []).find((c: Obj) => c.type === "tool_use");
  const matches: Obj[] = use?.input?.matches || [];

  // Keep only ids that really exist, so a made up id can never be booked.
  // id -> currency, so a dollar line is never pointed at a pound invoice.
  const known = new Map<string, string>(
    [...(inv.data || []), ...paidOpen, ...(bills.data || []), ...(exps.data || []), ...(others.data || [])]
      .map((x: Obj) => [x.id, x.currency || "GBP"] as [string, string]),
  );
  const peopleIds = new Set((people.data || []).map((p: Obj) => p.id));
  const catIds = new Set((cats.data || []).map((c: Obj) => c.id));
  const now = new Date().toISOString();
  for (const t of txns) {
    const m = matches.find((x) => x.txn_id === t.id);
    const needsTarget = ["invoice", "bill", "expense", "refund"].includes(m?.kind);
    const ok = m && (!needsTarget || (m.target_id && known.get(m.target_id) === (t.currency || "GBP") && m.target_id !== t.id));
    const ai = ok ? {
      kind: m.kind, target_id: needsTarget ? m.target_id : null,
      confidence: Math.max(0, Math.min(1, Number(m.confidence) || 0)),
      reason: String(m.reason || "").slice(0, 300),
      person_id: m.person_id && peopleIds.has(m.person_id) ? m.person_id : null,
      category_id: m.category_id && catIds.has(m.category_id) ? m.category_id : null,
    } : null;
    await admin.from("bank_transactions").update({ ai_match: ai, ai_checked_at: now }).eq("id", t.id);
  }
  return { checked: txns.length };
}
