// Bank-feed connect — Google Sheets provider (Monzo Business auto-export).
// Invoked from the app (verify_jwt=true) by an editor/owner. Unlike a hosted Open Banking
// flow there is NO bank redirect: "connecting" just validates we can read the configured
// Google Sheet and records one connection + one account row. Actions:
//   institutions -> the single available source (the Monzo sheet);
//   init         -> verify the sheet is readable, upsert connection + account, return {connected:true};
//   finalise     -> no-op (kept so the /bank/callback path stays harmless).
// NOTE: the Enable Banking adapter (_shared/enablebanking.ts) is parked on disk for any
// future EEA use; this build targets Google Sheets because Enable Banking has no UK coverage.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { readSheet, headerIndex, corsJson } from "../_shared/gsheets.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return corsJson({});
  if (req.method !== "POST") return corsJson({ error: "method" }, 405);

  // AuthZ: must be a signed-in editor/owner.
  const auth = req.headers.get("Authorization") || "";
  const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return corsJson({ error: "unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: prof } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (!prof || !["editor", "owner"].includes(prof.role)) return corsJson({ error: "forbidden" }, 403);

  const { action } = await req.json().catch(() => ({}));
  const sheetId = Deno.env.get("GSHEETS_BANK_SHEET_ID");
  const currency = Deno.env.get("GSHEETS_BANK_CURRENCY") || "GBP";

  try {
    if (action === "institutions") {
      // One source: the configured Monzo Google Sheet (UI shows it as the only "bank").
      return corsJson({ institutions: [{ id: "monzo-gsheets", name: "Monzo Business (Google Sheets)", logo: null }] });
    }

    if (action === "init") {
      if (!sheetId) return corsJson({ error: "GSHEETS_BANK_SHEET_ID not set — add the spreadsheet id as a secret." }, 400);
      // Verify we can actually read the sheet + it has a usable header row.
      const res = await readSheet(sheetId);
      if (!res.ok) return corsJson({ error: "Could not read the Google Sheet (check the share + GSHEETS_SA_KEY).", detail: res.error }, 502);
      const headers = res.rows[0] || [];
      const idx = headerIndex(headers);
      if (idx.date == null && idx.amount == null) {
        return corsJson({ error: "Sheet has no recognisable header row (need at least Date + Amount columns).", headers }, 422);
      }
      const reference = crypto.randomUUID();
      // Connection: stable, no consent expiry (no SCA).
      const { data: existing } = await admin.from("bank_connections").select("id").eq("institution_id", "monzo-gsheets").maybeSingle();
      let connId = existing?.id;
      if (!connId) {
        const { data: conn } = await admin.from("bank_connections").insert({
          reference, institution_id: "monzo-gsheets", institution_name: "Monzo Business (Google Sheets)",
          aspsp_country: "GB", session_id: sheetId, status: "LN", created_by: user.id,
        }).select("id").single();
        connId = conn?.id;
      } else {
        await admin.from("bank_connections").update({ status: "LN", session_id: sheetId, updated_at: new Date().toISOString() }).eq("id", connId);
      }
      // One account anchored on the sheet id.
      await admin.from("bank_accounts").upsert({
        connection_id: connId, gc_account_id: sheetId, account_uid: sheetId, identification_hash: sheetId,
        name: "Monzo Business", currency, active: true, updated_at: new Date().toISOString(),
      }, { onConflict: "gc_account_id" });
      return corsJson({ connected: true, columns: headers });
    }

    if (action === "finalise") return corsJson({ status: "LN" });   // no redirect in the Sheets flow

    return corsJson({ error: "unknown action" }, 400);
  } catch (e) {
    return corsJson({ error: (e as Error).message }, 500);
  }
});
