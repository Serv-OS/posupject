// onboarding-form — the customer's side of the onboarding pack. Public by
// design (the customer has no login), so the token IS the credential and this
// function is the only way in.
//
// Three actions, all keyed on that token:
//   load        what to show: the venue name and anything already answered
//   upload-url  a short-lived signed URL so the browser can PUT a file straight
//               into the private bucket. Files never travel through this
//               function — a menu PDF or a table plan would blow the request
//               limit, and a signed URL keeps the bucket closed to everyone else.
//   submit      save the answers, then attach every uploaded file to the LOCATION
//
// It never returns anything the customer should not see: no ids beyond their own
// request, no other venues, no CRM data.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const BUCKET = "attachments";
const MAX_BYTES = 25 * 1024 * 1024;

// Two different jobs, deliberately not one function:
//  safeName — what the team SEES in the attachments list, so "Spring Menu.pdf"
//             stays readable.
//  pathSafe — what the file is STORED as. Spaces and punctuation in an object
//             key have to survive a signed URL round-trip, and the quickest way
//             to guarantee that is to not put them there.
const safeName = (n: string) =>
  (n || "file").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
const pathSafe = (n: string) =>
  safeName(n).replace(/\s+/g, "_").replace(/_+/g, "_");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const token = String(body?.token || "").trim();
  const action = String(body?.action || "load");
  if (!token) return json({ error: "Missing token" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: reqRow } = await supabase
    .from("onboarding_form_requests")
    .select("id, location_id, company_id, onboarding_id, answers, submitted_at, sent_to")
    .eq("token", token).maybeSingle();

  // Same answer for a bad token and a deleted one: nothing to probe for.
  if (!reqRow) return json({ error: "This link is not valid. Please ask your account manager for a new one." }, 404);

  // A pack created before its onboarding knew its venue would otherwise attach
  // the customer's menu and logo to the COMPANY — and on a partner company with
  // two dozen venues that is the difference between a useful record and a pile.
  // The onboarding is the authority on which venue this job is for, so fill a
  // blank from it. An explicitly chosen venue on the request is never overridden.
  if (!reqRow.location_id && reqRow.onboarding_id) {
    const { data: onb } = await supabase.from("onboardings")
      .select("location_id").eq("id", reqRow.onboarding_id).maybeSingle();
    if (onb?.location_id) {
      reqRow.location_id = onb.location_id;
      await supabase.from("onboarding_form_requests")
        .update({ location_id: onb.location_id, updated_at: new Date().toISOString() })
        .eq("id", reqRow.id);
    }
  }

  // Whose pack this is, for the page header.
  let venue = "";
  if (reqRow.location_id) {
    const { data: loc } = await supabase.from("locations").select("name").eq("id", reqRow.location_id).maybeSingle();
    venue = loc?.name || "";
  }
  if (!venue && reqRow.company_id) {
    const { data: co } = await supabase.from("companies").select("name").eq("id", reqRow.company_id).maybeSingle();
    venue = co?.name || "";
  }

  try {
    if (action === "load") {
      if (!reqRow.opened_at) {
        await supabase.from("onboarding_form_requests")
          .update({ opened_at: new Date().toISOString() }).eq("id", reqRow.id);
      }
      return json({
        venue,
        answers: reqRow.answers || {},
        submitted: !!reqRow.submitted_at,
      });
    }

    if (action === "upload-url") {
      if (reqRow.submitted_at) return json({ error: "This pack has already been submitted." }, 409);
      const name = safeName(String(body?.fileName || ""));
      const size = Number(body?.size || 0);
      if (size > MAX_BYTES) return json({ error: `${name} is larger than 25MB. Please send it to us by email instead.` }, 413);
      // Path is namespaced by the request id, so one customer can never write
      // over another's file, and a stray token cannot reach anything existing.
      const path = `onboarding/${reqRow.id}/${crypto.randomUUID()}-${pathSafe(name)}`;
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error) return json({ error: error.message }, 500);
      return json({ path, token: data.token, signedUrl: data.signedUrl, name });
    }

    if (action === "submit") {
      if (reqRow.submitted_at) return json({ error: "This pack has already been submitted." }, 409);
      const answers = body?.answers && typeof body.answers === "object" ? body.answers : {};
      const files: any[] = Array.isArray(body?.files) ? body.files : [];
      const summary = String(body?.summary || "");
      const now = new Date().toISOString();

      await supabase.from("onboarding_form_requests")
        .update({ answers, submitted_at: now, updated_at: now }).eq("id", reqRow.id);

      // The files are the point: they land on the LOCATION, named as the
      // customer named them, so the venue record shows exactly what we were
      // given. Best-effort — a failed row here must not lose the answers.
      for (const f of files) {
        if (!f?.path) continue;
        try {
          await supabase.from("attachments").insert({
            subject_type: reqRow.location_id ? "location" : "company",
            subject_id: reqRow.location_id || reqRow.company_id,
            file_name: safeName(String(f.name || "file")),
            file_path: String(f.path),
            mime_type: f.mime || null,
            size_bytes: Number(f.size) || null,
            source: "onboarding_form",
          });
        } catch (e) { console.error("attachment row failed", (e as Error).message); }
      }

      // Leave a trace on the onboarding so the team sees it without hunting.
      if (reqRow.onboarding_id && summary) {
        try {
          await supabase.from("crm_activities").insert({
            type: "note", subject_type: "onboarding", subject_id: reqRow.onboarding_id,
            is_internal: true,
            subject: "Onboarding pack completed by the customer",
            body: summary.slice(0, 20000),
            channel_metadata: { kind: "onboarding_form", files: files.length },
          });
        } catch (e) { console.error("activity failed", (e as Error).message); }
      }

      return json({ ok: true, files: files.length });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("onboarding-form failed", e);
    return json({ error: (e as Error).message || "Something went wrong" }, 500);
  }
});
