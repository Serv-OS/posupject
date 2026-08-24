// onboarding-form-send — creates an onboarding pack for one venue and emails
// the customer their link.
//
// Deliberately separate from the public `onboarding-form` function and left
// JWT-protected: sending mail to an arbitrary address is exactly the action you
// do not expose without a login. Only a signed-in owner/editor gets here.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendInvoiceEmail } from "../_shared/invoiceEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const esc = (s: string) => String(s || "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") || "";
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: { user } } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role, display_name").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "editor"].includes(me.role)) return json({ error: "Not allowed" }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const to = String(body?.to || "").trim();
  const appUrl = String(body?.app_url || "").replace(/\/+$/, "");
  if (!to.includes("@")) return json({ error: "A valid email address is required" }, 422);
  if (!appUrl) return json({ error: "Missing app_url" }, 422);
  // Refuse to send a pack that has nowhere to land. Most onboardings sit under
  // a partner company with dozens of venues, so falling back to the company
  // would quietly pile every site's menu and table plan onto the partner.
  if (!body?.location_id) {
    return json({ error: "Choose the venue this onboarding is for before sending — the uploads attach to it." }, 422);
  }

  try {
    // One pack per venue: reuse an unsubmitted request rather than stacking up
    // links that all point at the same job (and confusing the customer).
    const { data: existing } = await supabase.from("onboarding_form_requests")
      .select("id, token, submitted_at")
      .eq("onboarding_id", body?.onboarding_id || null)
      .is("submitted_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();

    let row = existing;
    if (!row) {
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      const { data: created, error } = await supabase.from("onboarding_form_requests").insert({
        onboarding_id: body?.onboarding_id || null,
        location_id: body?.location_id || null,
        company_id: body?.company_id || null,
        contact_id: body?.contact_id || null,
        token, sent_to: to, created_by: user.id,
      }).select("id, token").single();
      if (error) return json({ error: error.message }, 500);
      row = created;
    }

    const link = `${appUrl}/onboarding/${row.token}`;
    const venue = String(body?.venue || "").trim();
    const who = String(body?.contact_name || "there").trim() || "there";

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0f1211">
        <p style="font-size:15px">Hi ${esc(who)},</p>
        <p style="font-size:15px;line-height:1.55">
          Great news, we're getting started on your new till${venue ? ` for <strong>${esc(venue)}</strong>` : ""}.
          To build it exactly how you want it, we need a few details from you: your company and trading
          information, your menu, your staff and how you'd like your kitchen tickets to print.
        </p>
        <p style="font-size:15px;line-height:1.55">
          It's all in one place here, and it saves as you go so you can stop and come back:
        </p>
        <p style="margin:26px 0">
          <a href="${link}" style="background:#15C26A;color:#06130C;padding:13px 26px;border-radius:10px;
             text-decoration:none;font-weight:700;font-size:15px;display:inline-block">Complete your onboarding pack</a>
        </p>
        <p style="font-size:13px;color:#5e665e;line-height:1.5">
          You can upload your menu, logo and table plan straight into the form. If anything is easier to talk
          through, just reply to this email.
        </p>
        <p style="font-size:13px;color:#5e665e">Thanks,<br>${esc(me.display_name || "The team")}</p>
        <p style="font-size:11px;color:#8c938c;margin-top:22px">
          If the button doesn't work, paste this into your browser:<br>${link}
        </p>
      </div>`;

    await sendInvoiceEmail(supabase, to, venue ? `Your onboarding pack for ${venue}` : "Your onboarding pack", html);

    const now = new Date().toISOString();
    await supabase.from("onboarding_form_requests")
      .update({ sent_to: to, sent_at: now, updated_at: now }).eq("id", row.id);

    if (body?.onboarding_id) {
      await supabase.from("crm_activities").insert({
        type: "note", subject_type: "onboarding", subject_id: body.onboarding_id, actor_id: user.id, is_internal: true,
        subject: "Onboarding pack sent",
        body: `Sent to ${to}.`,
        channel_metadata: { kind: "onboarding_form_sent" },
      });
    }

    return json({ ok: true, link, sent_to: to });
  } catch (e) {
    console.error("onboarding-form-send failed", e);
    return json({ error: (e as Error).message || "Could not send" }, 500);
  }
});
