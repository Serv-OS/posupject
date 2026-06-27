// Pull transactions + balances for linked bank accounts (GoCardless Bank Account Data).
// Daily cron (verify_jwt=false, service role); also accepts {connection_id} for an on-demand
// refresh. Rate limit is ~4 successful pulls/account/scope/day — we read the remaining/reset
// headers, skip exhausted accounts, and always re-pull a 10-day overlapping window (banks
// back-date/restate; pending->booked is an upsert, not a new row).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gcToken, gc, gcDedupKey, corsJson } from "../_shared/gocardless.ts";

const hdr = (h: Headers, name: string) => h.get(name) ?? h.get("HTTP_" + name.toUpperCase().replace(/-/g, "_")) ?? null;

serve(async (req) => {
  if (req.method !== "POST") return corsJson({ error: "method" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { connection_id } = await req.json().catch(() => ({}));

  try {
    const token = await gcToken();
    let q = admin.from("bank_accounts").select("*, connection:bank_connections!inner(id,status)").eq("active", true);
    if (connection_id) q = q.eq("connection_id", connection_id);
    const { data: accounts } = await q;

    const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const results: any[] = [];

    for (const a of (accounts || [])) {
      if ((a as any).connection?.status !== "LN") { results.push({ account: a.gc_account_id, skipped: "not linked" }); continue; }
      if (a.rl_remaining != null && a.rl_remaining <= 0 && a.rl_reset && new Date(a.rl_reset) > new Date()) { results.push({ account: a.gc_account_id, skipped: "rate-limited" }); continue; }

      const tx = await gc(token, `/accounts/${a.gc_account_id}/transactions/?date_from=${from}&date_to=${to}`);
      if (tx.status === 429) {
        const reset = Number(hdr(tx.headers, "x-ratelimit-account-success-reset") || 3600);
        await admin.from("bank_accounts").update({ rl_remaining: 0, rl_reset: new Date(Date.now() + reset * 1000).toISOString() }).eq("id", a.id);
        results.push({ account: a.gc_account_id, rate_limited: true }); continue;
      }
      if (!tx.ok) { results.push({ account: a.gc_account_id, error: tx.body }); continue; }

      const rows: any[] = [];
      for (const status of ["booked", "pending"]) {
        for (const t of (tx.body?.transactions?.[status] || [])) {
          rows.push({
            account_id: a.id, gc_account_id: a.gc_account_id, dedup_key: gcDedupKey(t), status,
            booking_date: t.bookingDate || null, value_date: t.valueDate || null,
            amount: Number(t.transactionAmount?.amount || 0), currency: t.transactionAmount?.currency || a.currency,
            payee: t.creditorName || t.debtorName || null, description: t.remittanceInformationUnstructured || null,
            raw: t, synced_at: new Date().toISOString(),
          });
        }
      }
      if (rows.length) await admin.from("bank_transactions").upsert(rows, { onConflict: "gc_account_id,dedup_key" });

      // balance (best-effort; its own rate-limit scope)
      let balance: number | null = null, balanceAt: string | null = to;
      const bal = await gc(token, `/accounts/${a.gc_account_id}/balances/`);
      if (bal.ok) {
        const list = bal.body?.balances || [];
        const b = list.find((x: any) => ["interimAvailable", "interimBooked", "closingBooked"].includes(x.balanceType)) || list[0];
        if (b) { balance = Number(b.balanceAmount?.amount || 0); balanceAt = b.referenceDate || to; }
      }
      const rem = Number(hdr(tx.headers, "x-ratelimit-account-success-remaining"));
      await admin.from("bank_accounts").update({ balance, balance_at: balanceAt, last_synced_at: new Date().toISOString(), rl_remaining: Number.isFinite(rem) ? rem : null, rl_reset: null }).eq("id", a.id);
      await admin.from("bank_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", a.connection_id);
      results.push({ account: a.gc_account_id, imported: rows.length });
    }
    return corsJson({ synced: results.length, results });
  } catch (e) {
    return corsJson({ error: (e as Error).message }, 500);
  }
});
