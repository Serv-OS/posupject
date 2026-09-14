// Public invoice endpoint (no auth). GET ?token=... -> invoice + lines +
// seller branding + customer details for the hosted invoice page (/i/<token>),
// plus the invoice's issued credit notes and what is left to pay after them.

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

    const { data: inv } = await supabase.from("invoices").select("*").eq("public_token", token).maybeSingle();
    if (!inv || inv.status === "void") return json({ error: "Invoice not found" }, 404);

    const [{ data: items }, { data: company }, { data: contact }, { data: location }, { data: settings }, { data: credits }] = await Promise.all([
      supabase.from("invoice_line_items").select("*").eq("invoice_id", inv.id).order("sort"),
      inv.company_id ? supabase.from("companies").select("name, address, city, postcode").eq("id", inv.company_id).maybeSingle() : Promise.resolve({ data: null }),
      inv.contact_id ? supabase.from("contacts").select("first_name, last_name, email").eq("id", inv.contact_id).maybeSingle() : Promise.resolve({ data: null }),
      inv.location_id ? supabase.from("locations").select("name, address, city, postcode").eq("id", inv.location_id).maybeSingle() : Promise.resolve({ data: null }),
      supabase.from("support_settings").select("invoice_terms, business_name, business_address, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle(),
      // Issued only: a cancelled credit note no longer reduces the invoice, so
      // the customer is not shown it. Each keeps its own token for /c/<token>.
      supabase.from("credit_notes").select("credit_number, issue_date, total, public_token")
        .eq("invoice_id", inv.id).eq("status", "issued").order("credit_number"),
    ]);

    if (inv.status === "sent") await supabase.from("invoices").update({ status: "viewed" }).eq("id", inv.id);

    const s = settings || {};
    // The Pay button charges this figure (invoice-checkout uses the same rule).
    const balance_due = balanceDue(inv);
    // Credit that brings the balance to 0 settles the invoice: it is no longer
    // overdue even though its status is still sent or viewed.
    const overdue = !!inv.due_date && new Date(inv.due_date) < new Date(new Date().toDateString()) && !["paid", "void"].includes(inv.status) && balance_due > 0;
    return json({
      invoice: {
        number: inv.invoice_number, status: inv.status, issue_date: inv.issue_date, due_date: inv.due_date,
        po_number: inv.po_number || null,
        tax_rate: inv.tax_rate, subtotal: inv.subtotal, tax_amount: inv.tax_amount, total: inv.total,
        terms: inv.terms || s.invoice_terms || "", notes: inv.notes || "", paid_at: inv.paid_at,
        amount_paid: inv.amount_paid, overdue,
        // The page formats every figure in this. It was never sent, so a USD
        // invoice showed in pounds on its public page.
        currency: inv.currency || "GBP",
        amount_credited: Number(inv.amount_credited || 0), balance_due,
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
      credit_notes: (credits || []).map((c: any) => ({
        number: c.credit_number, issue_date: c.issue_date, total: c.total, public_token: c.public_token,
      })),
    });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
