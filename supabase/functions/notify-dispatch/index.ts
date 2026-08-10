// Delivers a notification to its recipient via email and/or SMS, respecting
// notification_preferences. Invoked by a DB trigger (pg_net) on INSERT into
// public.notifications — fire and forget.
//
// Email: sent from the connected support mailbox (gmail_connections).
// SMS: Twilio using TWILIO_FROM_NUMBER. UK 07… numbers are normalised to E.164.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendInvoiceEmail } from "../_shared/invoiceEmail.ts";

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

const TYPE_PREF: Record<string, string> = {
  mention: "notify_on_mention",
  assignment: "notify_on_assignment",
  reply: "notify_on_reply",
  // 'system' (e.g. new support ticket) always delivers — vital for support
};

function e164(raw: string): string | null {
  let n = (raw || "").replace(/[\s()-]/g, "");
  if (!n) return null;
  if (n.startsWith("+")) return n;
  if (n.startsWith("07")) return "+44" + n.slice(1);
  if (n.startsWith("447")) return "+" + n;
  if (n.startsWith("0044")) return "+" + n.slice(2);
  return null;
}

function inQuietHours(start: string | null, end: string | null): boolean {
  if (!start || !end) return false;
  const now = new Date().toLocaleTimeString("en-GB", { hour12: false, timeZone: "Europe/London" }).slice(0, 5);
  return start < end ? (now >= start && now < end) : (now >= start || now < end);
}

// Post a notification to a Google Chat space via its incoming webhook.
// `mentionIds` are Google numeric user IDs to @mention (gives them a personal ping).
async function postToChat(webhookUrl: string, title: string, body: string, appUrl: string, mentionIds: string[] = []): Promise<void> {
  const mentions = mentionIds.filter(Boolean).map((id) => `<users/${id}>`).join(" ");
  const text = `${mentions ? mentions + "\n" : ""}*${title || "CRM notification"}*${body ? `\n${body}` : ""}\n<${appUrl}|Open CRM>`;
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Chat webhook HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Resolve (and cache) a user's Google numeric ID from their connected Google
// account, so we can @mention them in Chat. Returns null if not resolvable.
async function resolveGoogleId(supabase: any, profileId: string): Promise<string | null> {
  const { data: prof } = await supabase.from("profiles").select("google_chat_id").eq("id", profileId).maybeSingle();
  if (prof?.google_chat_id) return prof.google_chat_id;
  const { data: integ } = await supabase.from("user_integrations")
    .select("id, access_token, refresh_token, token_expires_at").eq("profile_id", profileId).eq("provider", "google").maybeSingle();
  if (!integ?.refresh_token) return null;

  let token = integ.access_token;
  const expired = !integ.token_expires_at || new Date(integ.token_expires_at).getTime() - Date.now() < 60000;
  if (expired) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: Deno.env.get("GMAIL_CLIENT_ID")!, client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
        refresh_token: integ.refresh_token, grant_type: "refresh_token",
      }),
    });
    const t = await r.json();
    if (!t.access_token) return null;
    token = t.access_token;
    await supabase.from("user_integrations").update({
      access_token: t.access_token, token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    }).eq("id", integ.id);
  }
  const ui = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${token}` } });
  const sub = (await ui.json())?.sub;
  if (sub) await supabase.from("profiles").update({ google_chat_id: sub }).eq("id", profileId);
  return sub || null;
}

// ---- Google Chat app (service account) for private 1:1 DMs ------------------
const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

// Mint an access token for the Chat app from its service-account key (RS256).
async function getChatAppToken(saKey: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64url(new TextEncoder().encode(JSON.stringify({
    iss: saKey.client_email,
    scope: "https://www.googleapis.com/auth/chat.bot",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  })));
  const signingInput = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(saKey.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error("Chat app token: " + JSON.stringify(d));
  return d.access_token;
}

// Send a private DM from the Chat app to a user (by email). Returns a status string.
async function dmChatUser(token: string, userEmail: string, title: string, body: string, appUrl: string): Promise<string> {
  const find = await fetch(
    `https://chat.googleapis.com/v1/spaces:findDirectMessage?name=${encodeURIComponent("users/" + userEmail)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (find.status === 404) return "no DM space (user must message the app once)";
  if (!find.ok) return `findDirectMessage HTTP ${find.status}: ${(await find.text()).slice(0, 150)}`;
  const space = (await find.json()).name;
  const text = `*${title || "CRM notification"}*${body ? `\n${body}` : ""}\n<${appUrl}|Open CRM>`;
  const post = await fetch(`https://chat.googleapis.com/v1/${space}/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!post.ok) return `send HTTP ${post.status}: ${(await post.text()).slice(0, 150)}`;
  return "sent";
}

serve(async (req) => {
  try {
    const payload = await req.json().catch(() => ({}));
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const appUrl = Deno.env.get("APP_URL") || "https://posupject.vercel.app";

    // Test path: Settings "Send test" button -> post a sample to the Chat space.
    if (payload.test_chat) {
      const { data: s } = await supabase.from("support_settings")
        .select("chat_webhook_url").eq("id", 1).maybeSingle();
      if (!s?.chat_webhook_url) return json({ error: "No Chat webhook URL saved" }, 400);
      try {
        await postToChat(s.chat_webhook_url, "Test notification",
          "If you can see this, Google Chat notifications are working. \u{1F389}", appUrl);
        return json({ ok: true, chat: "sent" });
      } catch (e) { return json({ error: (e as Error).message }, 502); }
    }

    // Test path: "Send test DM" -> private DM to the given email via the Chat app.
    if (payload.test_dm) {
      const saRaw = Deno.env.get("GOOGLE_CHAT_SA_KEY");
      if (!saRaw) return json({ error: "Google Chat app not configured (no service-account key)" }, 400);
      try {
        const token = await getChatAppToken(JSON.parse(saRaw));
        const r = await dmChatUser(token, payload.test_dm, "Test DM",
          "If you can see this, private Google Chat alerts are working. \u{1F389}", appUrl);
        return r === "sent" ? json({ ok: true, dm: r }) : json({ error: r }, 502);
      } catch (e) { return json({ error: (e as Error).message }, 502); }
    }

    const notification_id = payload.notification_id;
    if (!notification_id) return json({ error: "notification_id required" }, 400);

    const { data: n } = await supabase.from("notifications").select("*").eq("id", notification_id).maybeSingle();
    if (!n) return json({ error: "not found" }, 404);
    if (n.emailed_at || n.smsed_at || n.chatted_at || n.chat_dm_at) return json({ skipped: "already delivered" });

    // Land on the RECORD, not the dashboard. Every notification already knows
    // what it is about (entity_type + link_id — the in-app bell navigates with
    // exactly this pair), but the email button linked to the bare app URL, so
    // "Open CRM" dropped people on whatever screen the app opened with and left
    // them hunting for the lead or ticket the email was about. Shell.jsx reads
    // ?open=<type>:<id> on load and performs the same navigation as the bell.
    const deepUrl = n.entity_type && n.link_id
      ? `${appUrl}/?open=${encodeURIComponent(n.entity_type)}:${encodeURIComponent(n.link_id)}`
      : appUrl;
    const openLabel = n.entity_type ? `Open ${String(n.entity_type).replace(/_/g, " ")}` : "Open CRM";

    const { data: p } = await supabase.from("profiles")
      .select("email, phone, mobile, display_name").eq("id", n.recipient_id).maybeSingle();
    if (!p) return json({ skipped: "no profile" });

    const { data: prefs } = await supabase.from("notification_preferences")
      .select("*").eq("profile_id", n.recipient_id).maybeSingle();
    const emailOn = prefs ? !!prefs.email_enabled : true;   // default: email on
    const smsOn = prefs ? !!prefs.sms_enabled : false;      // default: sms off
    const typePref = TYPE_PREF[n.type];
    if (typePref && prefs && prefs[typePref] === false) return json({ skipped: "type disabled" });
    const quiet = inQuietHours(prefs?.quiet_hours_start || null, prefs?.quiet_hours_end || null);

    const updates: Record<string, string> = {};
    const results: Record<string, string> = {};

    if (emailOn && p.email) {
      try {
        const html = `
<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <div style="font-size:13px;color:#777;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">CRM notification</div>
  <div style="font-size:18px;font-weight:700;color:#111;margin-bottom:6px">${n.title || "Notification"}</div>
  ${n.body ? `<div style="font-size:14px;color:#444;margin-bottom:18px">${n.body}</div>` : ""}
  <a href="${deepUrl}" style="display:inline-block;background:#15C26A;color:#fff;font-weight:600;font-size:14px;padding:10px 22px;border-radius:8px;text-decoration:none">${openLabel}</a>
  <div style="font-size:11px;color:#999;margin-top:20px">You can change notification preferences in your account settings.</div>
</div>`;
        await sendInvoiceEmail(supabase, p.email, n.title || "CRM notification", html);
        updates.emailed_at = new Date().toISOString();
        results.email = "sent";
      } catch (e) { results.email = "failed: " + (e as Error).message; }
    }

    if (smsOn && !quiet) {
      const to = e164(p.mobile || p.phone || "");
      const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
      const tok = Deno.env.get("TWILIO_AUTH_TOKEN");
      const from = Deno.env.get("TWILIO_FROM_NUMBER");
      if (to && sid && tok && from) {
        try {
          const body = `${n.title || "CRM notification"}${n.body ? " — " + n.body : ""}`.slice(0, 150);
          const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
            method: "POST",
            headers: {
              Authorization: "Basic " + btoa(`${sid}:${tok}`),
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ From: from, To: to, Body: body }),
          });
          if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || `HTTP ${res.status}`);
          updates.smsed_at = new Date().toISOString();
          results.sms = "sent";
        } catch (e) { results.sms = "failed: " + (e as Error).message; }
      } else {
        results.sms = to ? "twilio not configured" : "no mobile number on profile";
      }
    } else if (smsOn && quiet) {
      results.sms = "skipped: quiet hours";
    }

    // Private Google Chat DM (per-user, sent by the Chat app's service account).
    const chatDmOn = prefs ? !!prefs.chat_dm_enabled : false;
    if (chatDmOn && !quiet && p.email) {
      const saRaw = Deno.env.get("GOOGLE_CHAT_SA_KEY");
      if (saRaw) {
        try {
          const token = await getChatAppToken(JSON.parse(saRaw));
          const r = await dmChatUser(token, p.email, n.title, n.body, deepUrl);
          results.chat_dm = r;
          if (r === "sent") updates.chat_dm_at = new Date().toISOString();
        } catch (e) { results.chat_dm = "failed: " + (e as Error).message; }
      } else {
        results.chat_dm = "chat app not configured";
      }
    } else if (chatDmOn && quiet) {
      results.chat_dm = "skipped: quiet hours";
    }

    // Google Chat (team space). Instance-level, not per-user: one shared feed.
    // A single event fans out to N recipient rows, so dedupe to one Chat post
    // by skipping if a sibling notification (same title+link, created within
    // 30s) already went to Chat.
    const { data: cfg } = await supabase.from("support_settings")
      .select("chat_webhook_url, chat_notify_enabled").eq("id", 1).maybeSingle();
    if (cfg?.chat_notify_enabled && cfg.chat_webhook_url) {
      const since = new Date(new Date(n.created_at).getTime() - 30000).toISOString();
      let q = supabase.from("notifications")
        .select("id").eq("title", n.title).not("chatted_at", "is", null)
        .gte("created_at", since).neq("id", n.id);
      q = n.link_id ? q.eq("link_id", n.link_id) : q.is("link_id", null);
      const { data: sibling } = await q.limit(1);
      if ((sibling || []).length > 0) {
        results.chat = "skipped: already posted for this event";
      } else {
        try {
          // Gather everyone this event notified, so each is @mentioned (and
          // personally pinged) in the single space post.
          let rq = supabase.from("notifications").select("recipient_id")
            .eq("title", n.title).gte("created_at", since);
          rq = n.link_id ? rq.eq("link_id", n.link_id) : rq.is("link_id", null);
          const { data: rows } = await rq;
          const recipientIds = [...new Set([n.recipient_id, ...((rows || []).map((r: any) => r.recipient_id))])].filter(Boolean);
          const mentionIds = (await Promise.all(recipientIds.map((id) => resolveGoogleId(supabase, id)))).filter(Boolean) as string[];
          await postToChat(cfg.chat_webhook_url, n.title, n.body, deepUrl, mentionIds);
          updates.chatted_at = new Date().toISOString();
          results.chat = "sent";
        } catch (e) { results.chat = "failed: " + (e as Error).message; }
      }
    }

    if (Object.keys(updates).length) await supabase.from("notifications").update(updates).eq("id", n.id);
    return json({ ok: true, ...results });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
