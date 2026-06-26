// Recurring supplier-bill generator. Called daily by pg_cron (06:00 UTC). For every
// active recurring_bills schedule whose next_run is due: create the bill from the template
// lines as 'to_pay' (never auto-paid) and advance next_run. Idempotent (next_run moves
// forward after generation, so repeat calls no-op). Deploy --no-verify-jwt (cron has no JWT;
// uses the service role internally). Mirrors invoice-recurring.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function advance(fromIso: string, frequency: string, dayOfMonth: number): string {
  const d = new Date(fromIso + "T00:00:00Z");
  const months = frequency === "annual" ? 12 : frequency === "quarterly" ? 3 : 1;
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, Math.min(dayOfMonth || 1, 28)));
  return next.toISOString().slice(0, 10);
}
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data: due } = await supabase.from("recurring_bills")
      .select("*").eq("active", true).lte("next_run", todayIso);

    const results: any[] = [];
    for (const s of (due || [])) {
      try {
        const lines = Array.isArray(s.lines) ? s.lines : [];
        let net = 0, vat = 0;
        for (const l of lines) {
          const ln = round2((Number(l.qty) || 1) * (Number(l.unit_price) || 0));
          net += ln; vat += round2(ln * (Number(l.tax_rate ?? 20) || 0) / 100);
        }
        net = round2(net); vat = round2(vat);
        const dueDate = new Date(Date.now() + (Number(s.due_days) || 14) * 86400000).toISOString().slice(0, 10);

        const { data: bill, error: bErr } = await supabase.from("bills").insert({
          supplier_id: s.supplier_id, category_id: s.category_id, company_id: s.company_id,
          location_id: s.location_id, deal_id: s.deal_id, cost_context: s.cost_context || "ongoing",
          status: "to_pay", description: s.label, currency: s.currency || "GBP",
          issue_date: todayIso, due_date: dueDate, subtotal: net, tax_amount: vat, total: round2(net + vat),
          recurring_id: s.id, created_by: s.created_by,
        }).select().single();
        if (bErr) throw bErr;

        if (lines.length) {
          await supabase.from("bill_line_items").insert(lines.map((l: any, i: number) => ({
            bill_id: bill.id, name: l.name || "Item", description: l.description || null,
            qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0,
            tax_rate: Number(l.tax_rate ?? 20) || 0, category_id: l.category_id || s.category_id || null,
            line_total: round2((Number(l.qty) || 1) * (Number(l.unit_price) || 0)), sort: i,
          })));
        }

        await supabase.from("recurring_bills").update({
          next_run: advance(s.next_run, s.frequency, s.day_of_month),
          last_run_at: new Date().toISOString(),
        }).eq("id", s.id);

        results.push({ schedule: s.id, bill: bill.bill_number });
      } catch (e) {
        results.push({ schedule: s.id, error: (e as Error).message });
      }
    }
    return json({ generated: results.length, results });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
