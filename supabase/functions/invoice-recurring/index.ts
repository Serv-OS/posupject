// Recurring invoice generator. Called daily by pg_cron (06:00 UTC). For every
// active schedule whose next_run is due: create the invoice from the template
// lines, email it to the customer (when auto_send), and advance next_run.
// Idempotent: next_run moves forward after generation, so repeat calls no-op.
// Deployed --no-verify-jwt (cron has no JWT); uses the service role internally.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { invoiceEmailHtml, sendInvoiceEmail, moneyFor, taxLabelFor, dateLocaleFor } from "../_shared/invoiceEmail.ts";
import { buildInvoicePdfBytes } from "../_shared/invoicePdf.ts";

// "Today" in a named timezone. The cron fires at 06:00 UTC, which is still
// YESTERDAY evening on the US west coast — a USD schedule dated by UTC would
// issue and advance a day early. GBP schedules keep London's calendar.
function todayIn(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// Next occurrence: advance by the frequency, clamped to day_of_month (1-28).
function advance(fromIso: string, frequency: string, dayOfMonth: number): string {
  const d = new Date(fromIso + "T00:00:00Z");
  const months = frequency === "annual" ? 12 : frequency === "quarterly" ? 3 : 1;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(dayOfMonth, 28)));
  return next.toISOString().slice(0, 10);
}

// Advance to the first occurrence AFTER today.
//
// Stepping a single period was the bug behind duplicate invoices: a schedule
// that had fallen behind (next_run 1 Jul, today 3 Aug) advanced only to 1 Aug,
// which is still due — so the daily cron billed it again the next morning, and
// the next, until it caught up. One invoice per day instead of per month.
function advancePastToday(fromIso: string, frequency: string, dayOfMonth: number, todayIso: string): string {
  let next = advance(fromIso, frequency, dayOfMonth);
  for (let i = 0; i < 120 && next <= todayIso; i++) {
    next = advance(next, frequency, dayOfMonth);
  }
  return next;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // Latest calendar wins for the DUE query (a schedule is picked up when it
    // is due anywhere we trade); each schedule then dates its invoice in its
    // own region's day below.
    const todayLondon = todayIn("Europe/London");
    const todayPacific = todayIn("America/Los_Angeles");
    const todayIso = todayLondon > todayPacific ? todayLondon : todayPacific;
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

        const currency = sched.currency || "GBP";
        const schedToday = currency === "USD" ? todayPacific : todayLondon;
        // The due query used the LATER calendar, which over-fetches by up to a
        // day for USD schedules (06:00 UTC is still yesterday evening on the
        // west coast). Each schedule only bills once its own region reaches
        // the date — otherwise every USD invoice would be issued and dated a
        // day early, forever.
        if (sched.next_run > schedToday) {
          results.push({ schedule: sched.id, skipped: `not yet ${sched.next_run} in ${currency === "USD" ? "US" : "UK"} time` });
          continue;
        }
        const dueDate = addDaysIso(schedToday, Number(sched.due_days) || 14);

        const { data: inv, error: invErr } = await supabase.from("invoices").insert({
          company_id: sched.company_id, location_id: sched.location_id, contact_id: sched.contact_id,
          currency,
          recurring_id: sched.id, status: "draft", issue_date: schedToday, due_date: dueDate,
          recurring_period: sched.next_run,   // unique per schedule — the DB rejects a repeat
          tax_rate: sched.tax_rate, subtotal, tax_amount: taxAmount, total,
          terms: sched.terms, notes: sched.notes, email_to: sched.email_to,
          created_by: sched.created_by,
        }).select().single();
        if (invErr) {
          // 23505 = the one-per-period guard. Someone/something already billed
          // this occurrence, so skip it and move the schedule on.
          if ((invErr as any).code === "23505") {
            await supabase.from("recurring_invoices").update({
              next_run: advancePastToday(sched.next_run, sched.frequency, sched.day_of_month, todayIso),
              last_run_at: new Date().toISOString(),
            }).eq("id", sched.id);
            results.push({ schedule: sched.id, skipped: "already invoiced for this period" });
            continue;
          }
          throw invErr;
        }

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
              fmt: moneyFor(currency),
              // The emailed PDF used the builder's defaults ('Tax', en-US)
              // while the in-app PDF of the same invoice said 'VAT' — now both
              // follow the invoice's currency.
              taxLabel: taxLabelFor(currency),
              dateLocale: dateLocaleFor(currency),
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
          next_run: advancePastToday(sched.next_run, sched.frequency, sched.day_of_month, todayIso),
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
