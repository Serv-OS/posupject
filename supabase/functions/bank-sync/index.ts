// Bank feed sync (verify_jwt off).
//
// Called three ways:
//   - by Monzo's webhook on every new transaction: POST ?account=acc_...
//     The webhook is not signed, so its body is never trusted. It only says
//     "look at this account now", and we read the account from Monzo
//     ourselves. An account we do not hold is ignored.
//   - by pg_cron every 30 minutes (migration 132), every active account
//   - by the Refresh button, {connection_id}
// Monzo accounts read the Monzo API; a Google Sheets connection still reads
// its sheet as before.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readSheet, headerIndex, mapSheetRow, corsJson } from "../_shared/gsheets.ts";
import { accessToken, syncMonzoAccount, syncMonzoBalance } from "../_shared/monzoSync.ts";

serve(async (req) => {
  if (req.method !== "POST") return corsJson({ error: "method" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);
  const hookAccount = url.searchParams.get("account");
  const { connection_id } = await req.json().catch(() => ({}));
  const defCur = Deno.env.get("GSHEETS_BANK_CURRENCY") || "GBP";

  try {
    let q = admin.from("bank_accounts").select("*, connection:bank_connections!inner(id,status,institution_id)").eq("active", true);
    if (connection_id) q = q.eq("connection_id", connection_id);
    if (hookAccount) q = q.eq("provider_account_id", hookAccount);
    const { data: accounts } = await q;
    // A webhook for an account we do not hold: say OK so Monzo stops retrying.
    if (hookAccount && !accounts?.length) return corsJson({ ok: true, ignored: true });

    const results: any[] = [];
    let sheet: { ok: boolean; rows: string[][]; error?: any } | null = null;
    const tokens = new Map<string, string>();

    for (const a of (accounts || []) as any[]) {
      const conn = a.connection;
      if (conn?.status !== "LN") { results.push({ account: a.name, skipped: "not linked" }); continue; }

      if (conn.institution_id === "monzo") {
        try {
          if (!tokens.has(conn.id)) tokens.set(conn.id, await accessToken(admin, conn.id));
          const token = tokens.get(conn.id)!;
          const n = await syncMonzoAccount(admin, token, a, false);
          await syncMonzoBalance(admin, token, a);
          await admin.from("bank_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", conn.id);
          results.push({ account: a.name, synced: n });
        } catch (e) {
          results.push({ account: a.name, error: (e as Error).message });
        }
        continue;
      }

      // Google Sheets connection.
      const sid = a.account_uid || Deno.env.get("GSHEETS_BANK_SHEET_ID");
      if (!sid) { results.push({ account: a.gc_account_id, skipped: "no sheet id" }); continue; }
      if (!sheet) sheet = await readSheet(sid);
      if (!sheet.ok) { results.push({ account: a.gc_account_id, error: sheet.error }); sheet = null; continue; }
      const [headerRow, ...dataRows] = sheet.rows;
      if (!headerRow) { results.push({ account: a.gc_account_id, imported: 0, note: "empty sheet" }); continue; }
      const idx = headerIndex(headerRow);
      const rows: any[] = [];
      for (const r of dataRows) {
        const m = mapSheetRow(idx, r, defCur);
        if (m) rows.push({ account_id: a.id, gc_account_id: a.gc_account_id, ...m, raw: r, synced_at: new Date().toISOString() });
      }
      for (let i = 0; i < rows.length; i += 500) {
        await admin.from("bank_transactions").upsert(rows.slice(i, i + 500), { onConflict: "gc_account_id,dedup_key" });
      }
      const balance = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      await admin.from("bank_accounts").update({ balance: rows.length ? Math.round(balance * 100) / 100 : null, balance_at: new Date().toISOString().slice(0, 10), last_synced_at: new Date().toISOString() }).eq("id", a.id);
      await admin.from("bank_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", a.connection_id);
      results.push({ account: a.gc_account_id, imported: rows.length });
    }
    return corsJson({ synced: results.length, results });
  } catch (e) {
    return corsJson({ error: (e as Error).message }, 500);
  }
});
