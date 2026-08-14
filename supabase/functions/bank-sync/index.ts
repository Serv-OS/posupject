// Bank-feed sync — Google Sheets provider (Monzo Business auto-export).
// Daily cron (verify_jwt=false, service role); also accepts {connection_id} for an on-demand
// refresh from the BankFeedPanel "Refresh" button. Reads the configured sheet, maps each row
// to a bank_transactions row (Monzo "Amount" is already signed: money out = negative), and
// upserts on (gc_account_id, dedup_key) so a re-read of the whole sheet never duplicates.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readSheet, headerIndex, mapSheetRow, corsJson } from "../_shared/gsheets.ts";

serve(async (req) => {
  if (req.method !== "POST") return corsJson({ error: "method" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { connection_id } = await req.json().catch(() => ({}));
  const sheetId = Deno.env.get("GSHEETS_BANK_SHEET_ID");
  const defCur = Deno.env.get("GSHEETS_BANK_CURRENCY") || "GBP";

  try {
    let q = admin.from("bank_accounts").select("*, connection:bank_connections!inner(id,status,institution_id)").eq("active", true);
    if (connection_id) q = q.eq("connection_id", connection_id);
    const { data: accounts } = await q;

    const results: any[] = [];
    // Read the sheet once (all Monzo accounts here share the one configured sheet).
    let sheet: { ok: boolean; rows: string[][]; error?: any } | null = null;

    for (const a of (accounts || [])) {
      if ((a as any).connection?.status !== "LN") { results.push({ account: a.gc_account_id, skipped: "not linked" }); continue; }
      const sid = a.account_uid || sheetId;
      if (!sid) { results.push({ account: a.gc_account_id, skipped: "no sheet id" }); continue; }

      if (!sheet) sheet = await readSheet(sid);
      if (!sheet.ok) { results.push({ account: a.gc_account_id, error: sheet.error }); sheet = null; continue; }
      const [headerRow, ...dataRows] = sheet.rows;
      if (!headerRow) { results.push({ account: a.gc_account_id, imported: 0, note: "empty sheet" }); continue; }
      const idx = headerIndex(headerRow);

      const rows: any[] = [];
      for (const r of dataRows) {
        const m = mapSheetRow(idx, r, defCur);
        if (!m) continue;
        rows.push({ account_id: a.id, gc_account_id: a.gc_account_id, ...m, raw: r, synced_at: new Date().toISOString() });
      }
      if (rows.length) {
        // Chunk upserts to stay well under payload limits on big histories.
        for (let i = 0; i < rows.length; i += 500) {
          await admin.from("bank_transactions").upsert(rows.slice(i, i + 500), { onConflict: "gc_account_id,dedup_key" });
        }
      }
      // Balance = running sum of all mapped amounts (best-effort; Monzo export has no balance col).
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
