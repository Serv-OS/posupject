// Shared: ensure exactly one invoice exists for a quote's one-off charges.
// Called when a quote is signed (creates it) and from the Stripe webhook
// (finds it and marks it paid). Returns the invoice row, or null when the
// quote has no one-off value to invoice.

export async function ensureInvoiceForQuote(supabase: any, q: any): Promise<any | null> {
  if (!q || Number(q.one_off_total || 0) <= 0) {
    // Legit for recurring-only quotes, but log it so a quote whose totals
    // weren't saved yet at sign-time doesn't vanish without a trace.
    if (q) console.log(`ensureInvoiceForQuote: Q-${q.quote_number} has no one-off total (${q.one_off_total}) — no invoice raised`);
    return null;
  }

  const { data: existing } = await supabase.from("invoices")
    .select("*").eq("quote_id", q.id).limit(1);
  if (existing?.length) return existing[0];

  const today = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const { data: inv, error } = await supabase.from("invoices").insert({
    quote_id: q.id, company_id: q.company_id, location_id: q.location_id, contact_id: q.contact_id,
    status: "sent", issue_date: today, due_date: due,
    subtotal: q.one_off_subtotal, tax_amount: q.tax_amount, total: q.one_off_total,
    notes: `Generated automatically from signed quote Q-${q.quote_number}.`,
    created_by: q.created_by,
  }).select().single();
  // Never fail silently: a missed invoice on a signed quote is money lost.
  if (error || !inv) {
    console.error(`ensureInvoiceForQuote: invoice insert failed for Q-${q.quote_number}:`, error?.message || "no row returned");
    return null;
  }

  const { data: lines } = await supabase.from("quote_line_items")
    .select("*").eq("quote_id", q.id).eq("billing_type", "one_off").order("sort");
  if (lines?.length) {
    await supabase.from("invoice_line_items").insert(lines.map((l: any, i: number) => ({
      invoice_id: inv.id, name: l.name, description: l.description,
      qty: Number(l.qty) || 1,
      unit_price: (Number(l.unit_price) || 0) * (1 - (Number(l.discount) || 0) / 100),
      tax_rate: Number(l.tax_rate) || 0, sort: i,
    })));
  }
  return inv;
}

export async function quoteContactEmail(supabase: any, q: any): Promise<string> {
  if (!q?.contact_id) return "";
  const { data: c } = await supabase.from("contacts").select("email").eq("id", q.contact_id).maybeSingle();
  return c?.email || "";
}
