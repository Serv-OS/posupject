// Gmail Send - Sends email reply from support@serv-os.app via Gmail API
// Called by frontend when agent sends an email from a ticket
//
// Required Supabase Secrets:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encodeMimeWord, decodeMimeWords } from "../_shared/mime.ts";
import { headerList, invalidAddresses, parseAddressList, mailboxKey } from "../_shared/addresses.ts";
import { bytesToB64, loadAttachmentsForSend, storeAttachment } from "../_shared/attachments.ts";

type OutAttachment = { name: string; mime: string; bytes: Uint8Array; path: string };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(supabase: any): Promise<{ token: string; email: string }> {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET")!;

  // Read refresh token from database (in-app OAuth connection)
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("refresh_token, email")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  // Only send from an account explicitly connected via the in-app flow.
  // No fallback to a GMAIL_REFRESH_TOKEN secret (that was a personal inbox).
  const refreshToken = conn?.refresh_token;
  if (!refreshToken) throw new Error("No Gmail account connected. Connect a support mailbox in Settings.");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get Gmail access token");
  // The mailbox address comes back too: it is ours, so it must never be a recipient.
  return { token: data.access_token, email: String(conn?.email || "").trim().toLowerCase() };
}

// Wrap base64 at 76 chars per RFC 2045 for the MIME body.
function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function createMimeMessage(to: string, subject: string, body: string, inReplyTo?: string, references?: string, attachments: OutAttachment[] = [], cc = "", messageId = `<${crypto.randomUUID()}@serv-os.app>`): string {

  const headers = [
    `From: ServOS Support <support@serv-os.app>`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    `MIME-Version: 1.0`,
    `Message-ID: ${messageId}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  let raw: string;
  if (attachments.length) {
    // multipart/mixed: the text body then each file as a base64 part.
    const boundary = "b_" + crypto.randomUUID().replace(/-/g, "");
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts: string[] = [];
    parts.push(
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      wrap76(bytesToB64(new TextEncoder().encode(body))),
    );
    for (const a of attachments) {
      const fname = (a.name || "file").replace(/["\r\n]/g, "_");
      parts.push(
        `--${boundary}\r\n` +
        `Content-Type: ${a.mime || "application/octet-stream"}; name="${fname}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n` +
        `Content-Disposition: attachment; filename="${fname}"\r\n\r\n` +
        wrap76(bytesToB64(a.bytes)),
      );
    }
    raw = headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n") + `\r\n--${boundary}--`;
  } else {
    headers.push(`Content-Type: text/plain; charset=UTF-8`);
    raw = headers.join("\r\n") + "\r\n\r\n" + body;
  }

  // Base64url encode the whole message for the Gmail send endpoint.
  return btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify the JWT to get the user
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = await req.json();

    // Who an older inbound email went to. Emails captured before To and Cc were
    // stored carry only From, so Reply all had nobody to copy. Read the headers
    // back from Gmail once, keep them on the message, and return them.
    if (payload?.action === "recipients") {
      const reply = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      const { data: act } = await supabase.from("crm_activities")
        .select("id, type, subject_type, channel_metadata")
        .eq("id", payload.activity_id).maybeSingle();
      const cm = act?.channel_metadata || {};
      if (!act || act.type !== "email" || act.subject_type !== "ticket" || !cm.gmail_message_id) return reply(404, { error: "Not a ticket email" });
      if ("to" in cm) return reply(200, { from: cm.from || null, to: cm.to || null, cc: cm.cc || null, reply_to: cm.reply_to || null });
      const { token } = await getAccessToken(supabase);
      const hdrs = ["To", "Cc", "Reply-To", "References"].map((h) => `metadataHeaders=${h}`).join("&");
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(cm.gmail_message_id)}?format=metadata&${hdrs}`, { headers: { Authorization: `Bearer ${token}` } });
      const m = await r.json();
      if (!r.ok) return reply(502, { error: m?.error?.message || "Could not read the email from Gmail" });
      const hs: any[] = m.payload?.headers || [];
      const get = (n: string) => decodeMimeWords(hs.find((h) => String(h.name).toLowerCase() === n.toLowerCase())?.value || "") || null;
      const found = { to: get("To"), cc: get("Cc"), reply_to: get("Reply-To"), references: get("References") };
      await supabase.from("crm_activities").update({ channel_metadata: { ...cm, ...found } }).eq("id", act.id);
      return reply(200, { from: cm.from || null, to: found.to, cc: found.cc, reply_to: found.reply_to });
    }

    const { ticket_id, to, subject, body, cc, attachments } = payload;

    if (!ticket_id || !to || !body) {
      return new Response(JSON.stringify({ error: "Missing required fields: ticket_id, to, body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Clean the recipient lists before they go near a header: bare addresses,
    // no line breaks, nobody twice, and never our own mailbox, which would
    // otherwise sit on every Reply all.
    const refuse = (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const bad = [...invalidAddresses(to), ...invalidAddresses(cc)];
    if (bad.length) return refuse(`Not a valid email address: ${bad.join(", ")}`);
    const { data: ownRows } = await supabase.from("gmail_connections").select("email");
    const ownKeys = new Set<string>([...(ownRows || []).map((r: any) => mailboxKey(r.email)), "support@serv-os.app"]);
    const own = { has: (email: string) => ownKeys.has(mailboxKey(email)) };
    const toList = parseAddressList(to).filter((a) => !own.has(a.email));
    const taken = new Set(toList.map((a) => a.email));
    const ccList = parseAddressList(cc).filter((a) => !own.has(a.email) && !taken.has(a.email) && !!taken.add(a.email));
    if (!toList.length) return refuse("Add at least one recipient who is not our own mailbox.");
    if (toList.length + ccList.length > 20) return refuse("Too many recipients: 20 at most.");
    const toHeader = headerList(toList);
    const ccHeader = headerList(ccList);

    // Get ticket info and last email in thread for reply headers
    const { data: ticket } = await supabase
      .from("tickets")
      .select("id, subject")
      .eq("id", ticket_id)
      .single();

    // Find gmail thread ID for this ticket
    const { data: threadMapping } = await supabase
      .from("ticket_email_threads")
      .select("email_thread_id")
      .eq("ticket_id", ticket_id)
      .limit(1);

    const gmailThreadId = threadMapping?.[0]?.email_thread_id || null;

    // Find last inbound message for reply headers
    const { data: lastMessage } = await supabase
      .from("crm_activities")
      .select("message_id, thread_id, channel_metadata")
      .eq("subject_type", "ticket")
      .eq("subject_id", ticket_id)
      .eq("type", "email")
      .eq("direction", "inbound")
      .order("occurred_at", { ascending: false })
      .limit(1);

    const inReplyTo = lastMessage?.[0]?.message_id || undefined;
    // Carry the whole chain, so every mail client threads the reply correctly.
    const priorRefs = String(lastMessage?.[0]?.channel_metadata?.references || "").split(/\s+/).filter(Boolean);
    const references = [...new Set([...priorRefs, ...(inReplyTo ? [inReplyTo] : [])])].join(" ") || undefined;

    // Build and send email via Gmail API
    const { token: accessToken, email: mailbox } = await getAccessToken(supabase);
    // Pull any composer-uploaded files out of storage to attach to the reply.
    const outAtts = await loadAttachmentsForSend(supabase, Array.isArray(attachments) ? attachments : []);
    const _base = (ticket?.subject || "").replace(/^\s*(re:\s*)+/i, "").trim();
    const emailSubject = subject || (_base ? `Re: ${_base}` : "Support reply");
    // The Message-ID we send is the one we store, so replies to it thread back here.
    const sentMessageId = `<${crypto.randomUUID()}@serv-os.app>`;
    const rawMessage = createMimeMessage(toHeader, emailSubject, body, inReplyTo, references, outAtts, ccHeader, sentMessageId);

    const sendUrl = gmailThreadId
      ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`
      : `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`;

    const sendBody: any = { raw: rawMessage };
    if (gmailThreadId) sendBody.threadId = gmailThreadId;

    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendBody),
    });

    const sendResult = await sendRes.json();

    if (!sendRes.ok) {
      return new Response(JSON.stringify({ error: "Gmail send failed", details: sendResult }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create activity record
    const newMessageId = sentMessageId;

    const { data: activity } = await supabase.from("crm_activities").insert({
      type: "email",
      subject: emailSubject,
      body: body,
      subject_type: "ticket",
      subject_id: ticket_id,
      direction: "outbound",
      actor_id: user.id,
      message_id: newMessageId,
      in_reply_to: inReplyTo || null,
      thread_id: gmailThreadId || sendResult.threadId,
      is_internal: false,
      channel_metadata: {
        to: toHeader,
        cc: ccHeader || null,
        // The mailbox it really went from. posupcrm sends from its own address.
        from: mailbox || "support@serv-os.app",
        references: references || null,
        gmail_message_id: sendResult.id,
        gmail_thread_id: sendResult.threadId,
      },
    }).select().single();

    // Record sent attachments against the new activity so they show on the ticket.
    for (const a of outAtts) {
      await storeAttachment(supabase, {
        ticketId: ticket_id, activityId: activity?.id || null,
        name: a.name, mime: a.mime, bytes: a.bytes, source: "outbound_email", uploadedBy: user.id,
      });
    }

    // Store thread mapping if new
    if (!gmailThreadId && sendResult.threadId) {
      await supabase.from("ticket_email_threads").upsert({
        ticket_id: ticket_id,
        email_thread_id: sendResult.threadId,
      }, { onConflict: "email_thread_id" });
    }

    // Update ticket stage if it's 'new'
    const { data: currentTicket } = await supabase
      .from("tickets")
      .select("stage")
      .eq("id", ticket_id)
      .single();

    if (currentTicket?.stage === "new") {
      await supabase.from("tickets").update({ stage: "waiting_on_customer" }).eq("id", ticket_id);
      await supabase.from("stage_history").insert({
        object_type: "ticket",
        object_id: ticket_id,
        from_stage: "new",
        to_stage: "waiting_on_customer",
        changed_by: user.id,
      });
    }

    return new Response(
      JSON.stringify({ success: true, activity_id: activity?.id, gmail_id: sendResult.id }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Gmail send error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
