// Public quote endpoint (no auth).
//   GET  ?token=...           -> quote + line items for the customer to view
//   POST { token, name, signature } -> save the drawn signature, mark signed,
//         and (if terms = invoice_later) execute the quote immediately.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ensureInvoiceForQuote, quoteContactEmail } from "../_shared/quoteInvoice.ts";
import { invoiceEmailHtml, sendInvoiceEmail } from "../_shared/invoiceEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const token = req.method === "GET"
      ? new URL(req.url).searchParams.get("token")
      : (await req.clone().json().catch(() => ({})))?.token;
    if (!token) return json({ error: "Missing token" }, 400);

    const { data: quote } = await supabase.from("quotes").select("*").eq("public_token", token).maybeSingle();
    if (!quote) return json({ error: "Quote not found" }, 404);

    if (req.method === "GET") {
      const [{ data: items }, { data: company }, { data: contact }, { data: location }, { data: settings }] = await Promise.all([
        supabase.from("quote_line_items").select("*").eq("quote_id", quote.id).order("sort"),
        quote.company_id ? supabase.from("companies").select("name, address, city, postcode").eq("id", quote.company_id).maybeSingle() : Promise.resolve({ data: null }),
        quote.contact_id ? supabase.from("contacts").select("first_name, last_name, email, phone").eq("id", quote.contact_id).maybeSingle() : Promise.resolve({ data: null }),
        quote.location_id ? supabase.from("locations").select("name, address, city, postcode").eq("id", quote.location_id).maybeSingle() : Promise.resolve({ data: null }),
        supabase.from("support_settings").select("quote_terms, business_name, business_address, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle(),
      ]);
      if (quote.status === "sent") await supabase.from("quotes").update({ status: "viewed" }).eq("id", quote.id);
      const expired = quote.valid_until && new Date(quote.valid_until) < new Date(new Date().toDateString()) && !["won", "paid", "signed"].includes(quote.status);
      const s = settings || {};
      return json({
        quote: {
          number: quote.quote_number, status: quote.status, valid_until: quote.valid_until, go_live_date: quote.go_live_date,
          payment_terms: quote.payment_terms, deposit_percent: quote.deposit_percent,
          one_off_subtotal: quote.one_off_subtotal, tax_amount: quote.tax_amount, one_off_total: quote.one_off_total,
          recurring_arr: quote.recurring_arr, terms: quote.terms || s.quote_terms || "",
          signed: !!quote.signed_at, signed_by_name: quote.signed_by_name, created_at: quote.created_at, expired,
          card_processing: quote.card_processing || null,
        },
        seller: {
          name: s.business_name || "ServOS", address: s.business_address || "",
          email: s.business_email || "", phone: s.business_phone || "", accent: s.quote_accent || "#E8743C",
          logo_url: s.logo_url || null,
        },
        company: company ? { name: company.name, address: [company.address, company.city, company.postcode].filter(Boolean).join(", ") } : null,
        contact: contact ? { name: [contact.first_name, contact.last_name].filter(Boolean).join(" "), email: contact.email, phone: contact.phone } : null,
        location: location ? { name: location.name, address: [location.address, location.city, location.postcode].filter(Boolean).join(", ") } : null,
        items: items || [],
      });
    }

    // POST = sign
    const body = await req.json();
    const { name, signature } = body;
    if (!name || !signature) return json({ error: "Name and signature required" }, 422);
    if (["won", "paid"].includes(quote.status)) return json({ error: "This quote is already complete." }, 409);

    // Upload signature PNG (data URL -> bytes)
    let signaturePath: string | null = null;
    try {
      const b64 = signature.split(",")[1] || "";
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      signaturePath = `quotes/${quote.id}/signature-${Date.now()}.png`;
      await supabase.storage.from("attachments").upload(signaturePath, bytes, { contentType: "image/png", upsert: true });
    } catch (_) { /* keep going even if upload fails */ }

    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;
    await supabase.from("quotes").update({
      status: "signed", signed_at: new Date().toISOString(), signed_by_name: name, signer_ip: ip, signature_path: signaturePath,
    }).eq("id", quote.id);

    // Signing closes the deal (won + onboarding) right away. Payment, if any,
    // is still collected after — execute_quote is idempotent.
    await supabase.rpc("execute_quote", { p_quote_id: quote.id });

    // Signing also raises the invoice for the one-off charges. For pay-now /
    // deposit quotes the Stripe webhook marks this same invoice paid; for
    // invoice-later quotes we email it to the customer immediately.
    try {
      const inv = await ensureInvoiceForQuote(supabase, quote);
      if (inv && quote.payment_terms === "invoice_later") {
        const recipient = await quoteContactEmail(supabase, quote);
        if (recipient) {
          const { data: seller } = await supabase.from("support_settings")
            .select("business_name, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle();
          const appUrl = Deno.env.get("APP_URL") || "https://posupject.vercel.app";
          const { subject, html } = invoiceEmailHtml(inv, seller || {}, `${appUrl}/i/${inv.public_token}`, {});
          await sendInvoiceEmail(supabase, recipient, subject, html);
          await supabase.from("invoices").update({ sent_at: new Date().toISOString(), email_to: recipient }).eq("id", inv.id);
        }
      }
    } catch (e) {
      console.error("auto-invoice on sign failed:", (e as Error).message);
    }

    if (quote.payment_terms === "invoice_later") return json({ executed: true });
    return json({ executed: true, needs_payment: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
