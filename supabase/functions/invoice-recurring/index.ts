// Recurring invoice generator. Called daily by pg_cron (06:00 UTC). For every
// active schedule whose next_run is due: create the invoice from the template
// lines, email it to the customer (when auto_send), and advance next_run.
// Idempotent: next_run moves forward after generation, so repeat calls no-op.
// Deployed --no-verify-jwt (cron has no JWT); uses the service role internally.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { invoiceEmailHtml, sendInvoiceEmail, money } from "../_shared/invoiceEmail.ts";
import { buildInvoicePdfBytes } from "../_shared/invoicePdf.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// Next occurrence: advance by the frequency, clamped to day_of_month (1-28).
function advance(fromIso: string, frequency: string, dayOfMonth: number): string {
  const d = new Date(fromIso + "T00:00:00Z");
  const months = frequency === "annual" ? 12 : frequency === "quarterly" ? 3 : 1;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(dayOfMonth, 28)));
  return next.toISOString().slice(0, 10);
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data: due } = await supabase.from("recurring_invoices")
      .select("*").eq("active", true).lte("next_run", todayIso);

    const results: any[] = [];
    for (const sched of (due || [])) {
      try {
        const lines = Array.isArray(sched.lines) ? sched.lines : [];
        const subtotal = lines.reduce((s: number, l: any) => s + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0);
        const taxAmount = lines.reduce((s: number, l: any) =>
          s + (Number(l.qty) || 1) * (Number(l.unit_price) || 0) * (Number(l.tax_rate ?? sched.tax_rate) || 0) / 100, 0);
        const total = subtotal + taxAmount;

        const dueDate = new Date(Date.now() + (Number(sched.due_days) || 14) * 86400000).toISOString().slice(0, 10);

        const { data: inv, error: invErr } = await supabase.from("invoices").insert({
          company_id: sched.company_id, location_id: sched.location_id, contact_id: sched.contact_id,
          recurring_id: sched.id, status: "draft", issue_date: todayIso, due_date: dueDate,
          tax_rate: sched.tax_rate, subtotal, tax_amount: taxAmount, total,
          terms: sched.terms, notes: sched.notes, email_to: sched.email_to,
          created_by: sched.created_by,
        }).select().single();
        if (invErr) throw invErr;

        if (lines.length) {
          await supabase.from("invoice_line_items").insert(lines.map((l: any, i: number) => ({
            invoice_id: inv.id, name: l.name || "Item", description: l.description || null,
            qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0,
            tax_rate: Number(l.tax_rate ?? sched.tax_rate) || 0, sort: i,
          })));
        }

        // Auto-send by email when configured
        let sent = false, sendError: string | null = null;
        let recipient = (sched.email_to || "").trim();
        if (!recipient && sched.contact_id) {
          const { data: c } = await supabase.from("contacts").select("email").eq("id", sched.contact_id).maybeSingle();
          recipient = c?.email || "";
        }
        if (sched.auto_send && recipient) {
          try {
            const { data: seller } = await supabase.from("support_settings")
              .select("business_name, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle();
            const appUrl = Deno.env.get("APP_URL") || "https://posupject.vercel.app";
            const { subject, html } = invoiceEmailHtml(inv, seller || {}, `${appUrl}/i/${inv.public_token}`);

            // Bill-to parties for the PDF (contact is the customer; company/location shown when linked).
            const [{ data: contact }, { data: company }, { data: location }] = await Promise.all([
              sched.contact_id ? supabase.from("contacts").select("first_name, last_name, email").eq("id", sched.contact_id).maybeSingle() : Promise.resolve({ data: null }),
              sched.company_id ? supabase.from("companies").select("name").eq("id", sched.company_id).maybeSingle() : Promise.resolve({ data: null }),
              sched.location_id ? supabase.from("locations").select("name").eq("id", sched.location_id).maybeSingle() : Promise.resolve({ data: null }),
            ]);
            const contactName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(" ") : "";
            const pdfBytes = await buildInvoicePdfBytes({
              inv, lines,
              totals: { subtotal, tax: taxAmount, total },
              seller: { name: (seller as any)?.business_name, email: (seller as any)?.business_email, phone: (seller as any)?.business_phone, accent: (seller as any)?.quote_accent, logo_url: (seller as any)?.logo_url },
              billTo: { companyName: (company as any)?.name || "", contactName, contactEmail: recipient, locationName: (location as any)?.name || "" },
              fmt: money,
            });

            await sendInvoiceEmail(supabase, recipient, subject, html, { filename: `INV-${inv.invoice_number}.pdf`, bytes: pdfBytes });
            await supabase.from("invoices").update({ status: "sent", sent_at: new Date().toISOString(), email_to: recipient }).eq("id", inv.id);
            sent = true;
          } catch (e) {
            sendError = (e as Error).message; // invoice stays draft for manual send
          }
        }

        // Advance the schedule so repeat runs don't duplicate
        await supabase.from("recurring_invoices").update({
          next_run: advance(sched.next_run, sched.frequency, sched.day_of_month),
          last_run_at: new Date().toISOString(),
        }).eq("id", sched.id);

        results.push({ schedule: sched.id, invoice: inv.invoice_number, sent, sendError });
      } catch (e) {
        results.push({ schedule: sched.id, error: (e as Error).message });
      }
    }
    return json({ generated: results.length, results });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
