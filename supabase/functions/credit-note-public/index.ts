// Public credit note endpoint (no auth). GET ?token=... -> credit note + lines
// + the invoice it credits + seller branding + customer details for the hosted
// credit note page (/c/<token>). The unguessable token is the auth, as it is
// for invoice-public.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { balanceDue } from "../_shared/invoiceEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const token = new URL(req.url).searchParams.get("token");
    if (!token) return json({ error: "Missing token" }, 400);

    // A cancelled credit note no longer reduces the invoice. Showing it to the
    // customer from an old email would promise a credit they are not getting.
    const { data: note } = await supabase.from("credit_notes").select("*").eq("public_token", token).maybeSingle();
    if (!note || note.status === "cancelled") return json({ error: "Credit note not found" }, 404);

    const { data: inv } = await supabase.from("invoices").select("*").eq("id", note.invoice_id).maybeSingle();
    if (!inv) return json({ error: "Credit note not found" }, 404);

    // The note copied company, location and contact from the invoice when it
    // was issued; the invoice fills in any the note does not have.
    const companyId = note.company_id || inv.company_id;
    const contactId = note.contact_id || inv.contact_id;
    const locationId = note.location_id || inv.location_id;
    const [{ data: items }, { data: company }, { data: contact }, { data: location }, { data: settings }] = await Promise.all([
      supabase.from("credit_note_lines").select("id, name, description, qty, unit_price, tax_rate, sort").eq("credit_note_id", note.id).order("sort"),
      companyId ? supabase.from("companies").select("name, address, city, postcode").eq("id", companyId).maybeSingle() : Promise.resolve({ data: null }),
      contactId ? supabase.from("contacts").select("first_name, last_name, email").eq("id", contactId).maybeSingle() : Promise.resolve({ data: null }),
      locationId ? supabase.from("locations").select("name, address, city, postcode").eq("id", locationId).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("support_settings").select("business_name, business_address, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle(),
    ]);

    const s = settings || {};
    const currency = note.currency || inv.currency || "GBP";
    const voided = inv.status === "void";
    return json({
      credit_note: {
        number: note.credit_number, status: note.status, issue_date: note.issue_date, reason: note.reason,
        currency, subtotal: note.subtotal, tax_amount: note.tax_amount, total: note.total,
        // refund_note stays out: it is the staff's own record of the refund.
        refund_status: note.refund_status, refund_due: note.refund_due,
        refunded_at: note.refunded_at, refund_method: note.refund_method,
      },
      invoice: {
        number: inv.invoice_number, issue_date: inv.issue_date, due_date: inv.due_date,
        po_number: inv.po_number || null, currency: inv.currency || currency,
        total: inv.total, amount_credited: Number(inv.amount_credited || 0),
        // A void invoice asks for nothing, and its own page is gone.
        balance_due: voided ? 0 : balanceDue(inv),
        paid: inv.status === "paid",
        // Lets the page link back to the invoice. Only for a live invoice:
        // invoice-public returns 404 for a void one.
        public_token: voided ? null : inv.public_token,
      },
      seller: {
        name: s.business_name || "ServOS", address: s.business_address || "",
        email: s.business_email || "", phone: s.business_phone || "",
        accent: s.quote_accent || "#15C26A", logo_url: s.logo_url || null,
      },
      company: company ? { name: company.name, address: [company.address, company.city, company.postcode].filter(Boolean).join(", ") } : null,
      contact: contact ? { name: [contact.first_name, contact.last_name].filter(Boolean).join(" "), email: contact.email } : null,
      location: location ? { name: location.name, address: [location.address, location.city, location.postcode].filter(Boolean).join(", ") } : null,
      items: items || [],
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
