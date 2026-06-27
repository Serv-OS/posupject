// Interactive Open Banking connect flow (GoCardless Bank Account Data).
// Invoked from the app (verify_jwt=true) by an editor/owner. Actions:
//   institutions -> list GB banks; init -> create agreement+requisition, return hosted link;
//   finalise -> after the user returns from their bank, fetch linked accounts.
// All GoCardless calls are server-side; the client only ever gets the hosted link + rows.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { gcToken, gc, corsJson } from "../_shared/gocardless.ts";

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

  const { action, ...args } = await req.json().catch(() => ({}));
  const APP = Deno.env.get("APP_URL") || "https://posupject.vercel.app";

  try {
    const token = await gcToken();

    if (action === "institutions") {
      const { body } = await gc(token, `/institutions/?country=${(args.country || "gb")}`);
      const list = Array.isArray(body) ? body : [];
      return corsJson({ institutions: list.map((i: any) => ({ id: i.id, name: i.name, logo: i.logo, max_access_valid_for_days: i.max_access_valid_for_days, transaction_total_days: i.transaction_total_days })) });
    }

    if (action === "init") {
      const inst = args.institution_id;
      if (!inst) return corsJson({ error: "institution_id required" }, 400);
      const instRes = await gc(token, `/institutions/${inst}/`);
      const maxAccess = Math.min(90, Number(instRes.body?.max_access_valid_for_days || 90));
      const maxHist = Math.min(180, Number(instRes.body?.transaction_total_days || 180));
      const agr = await gc(token, `/agreements/enduser/`, { method: "POST", body: JSON.stringify({ institution_id: inst, max_historical_days: maxHist, access_valid_for_days: maxAccess, access_scope: ["balances", "details", "transactions"] }) });
      if (!agr.ok) return corsJson({ error: "agreement failed", detail: agr.body }, 502);
      const reference = crypto.randomUUID();
      const reqn = await gc(token, `/requisitions/`, { method: "POST", body: JSON.stringify({ redirect: `${APP}/bank/callback`, institution_id: inst, reference, agreement: agr.body.id, user_language: "EN" }) });
      if (!reqn.ok) return corsJson({ error: "requisition failed", detail: reqn.body }, 502);
      await admin.from("bank_connections").insert({
        reference, requisition_id: reqn.body.id, institution_id: inst, institution_name: instRes.body?.name || inst,
        agreement_id: agr.body.id, access_valid_days: maxAccess, status: reqn.body.status || "CR", created_by: user.id,
      });
      return corsJson({ link: reqn.body.link, reference });
    }

    if (action === "finalise") {
      const { data: conn } = await admin.from("bank_connections").select("*").eq("reference", args.reference).single();
      if (!conn) return corsJson({ error: "connection not found" }, 404);
      const reqn = await gc(token, `/requisitions/${conn.requisition_id}/`);
      const status = reqn.body?.status;
      const expires = conn.access_valid_days ? new Date(Date.now() + conn.access_valid_days * 86400000).toISOString().slice(0, 10) : null;
      await admin.from("bank_connections").update({ status, consent_expires_at: status === "LN" ? expires : conn.consent_expires_at, updated_at: new Date().toISOString() }).eq("id", conn.id);
      if (status === "LN") {
        for (const accId of (reqn.body.accounts || [])) {
          const det = await gc(token, `/accounts/${accId}/details/`);
          const d = det.body?.account || {};
          await admin.from("bank_accounts").upsert({
            connection_id: conn.id, gc_account_id: accId, iban: d.iban || null, owner_name: d.ownerName || null,
            currency: d.currency || "GBP", name: d.name || d.product || null, updated_at: new Date().toISOString(),
          }, { onConflict: "gc_account_id" });
        }
      }
      return corsJson({ status, accounts: reqn.body?.accounts || [] });
    }

    return corsJson({ error: "unknown action" }, 400);
  } catch (e) {
    return corsJson({ error: (e as Error).message }, 500);
  }
});
