// Gmail Check - Polls Gmail for new support emails and creates/threads tickets
// Triggered by pg_cron or manual call every 30-60 seconds
//
// Required Supabase Secrets:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { utf8FromB64Url, decodeMimeWords, encodeMimeWord } from "../_shared/mime.ts";
import { isOpenNow } from "../_shared/hours.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getActiveConnection(supabase: any): Promise<{ accessToken: string; conn: any } | null> {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET")!;

  // ONLY use an account explicitly connected via the in-app "Connect Gmail"
  // flow (gmail_connections). We deliberately do NOT fall back to a
  // GMAIL_REFRESH_TOKEN secret — that previously pointed at a personal
  // inbox (peter@serv-os.app) and polled it as if it were the support box.
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("id, email, refresh_token, access_token, token_expires_at, last_polled_at")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  const refreshToken = conn?.refresh_token;
  if (!refreshToken) return null; // nothing connected -> caller no-ops

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
  if (!data.access_token) throw new Error("Failed to get Gmail access token: " + JSON.stringify(data));

  await supabase.from("gmail_connections")
    .update({ access_token: data.access_token, token_expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString() })
    .eq("id", conn.id);

  return { accessToken: data.access_token, conn };
}

async function getGmailMessages(accessToken: string, afterEpochSeconds: number) {
  // Mail that arrived since we last polled. Gmail's after: accepts a unix
  // timestamp (seconds). We do NOT filter on is:unread: this is a shared
  // mailbox humans also read, so unread state is unreliable. Dedup by
  // message-id (below) prevents any message becoming a ticket twice.
  const query = `in:inbox after:${afterEpochSeconds}`;
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=30`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  return data.messages || [];
}

async function getGmailMessage(accessToken: string, messageId: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  return await res.json();
}

async function markAsRead(accessToken: string, messageId: string) {
  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
    }
  );
}

function getHeader(headers: any[], name: string): string {
  const h = headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// Send a threaded plain-text reply via the Gmail API (used for auto-reply)
async function sendGmailReply(accessToken: string, opts: {
  from: string; to: string; subject: string; body: string;
  inReplyTo?: string; references?: string; threadId?: string;
}): Promise<boolean> {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeMimeWord(opts.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`);
  const refs = opts.references || opts.inReplyTo;
  if (refs) lines.push(`References: ${refs}`);
  const raw = `${lines.join("\r\n")}\r\n\r\n${opts.body}`;
  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded, threadId: opts.threadId }),
  });
  return res.ok;
}

function extractEmail(str: string): string {
  const match = str.match(/<([^>]+)>/) || str.match(/([^\s<>]+@[^\s<>]+)/);
  return match ? match[1].toLowerCase() : str.toLowerCase().trim();
}

function extractName(str: string): string {
  const match = str.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : "";
}

function decodeBody(part: any): string {
  if (part.body?.data) {
    // Base64url of UTF-8 bytes -> decode as UTF-8 (raw atob mangles £, —, é …)
    return utf8FromB64Url(part.body.data);
  }
  if (part.parts) {
    // Prefer text/plain, fall back to text/html
    const textPart = part.parts.find((p: any) => p.mimeType === "text/plain");
    if (textPart) return decodeBody(textPart);
    const htmlPart = part.parts.find((p: any) => p.mimeType === "text/html");
    if (htmlPart) {
      const html = decodeBody(htmlPart);
      // Strip HTML tags for plain text
      return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    }
    // Recurse into first part
    return decodeBody(part.parts[0]);
  }
  return "";
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const active = await getActiveConnection(supabase);

    // No Gmail account connected via the in-app flow -> do nothing.
    // (Email support resumes automatically once support@ is connected.)
    if (!active) {
      return new Response(
        JSON.stringify({ success: true, processed: 0, total: 0, connected_mailbox: null, note: "No Gmail account connected" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const accessToken = active.accessToken;
    const conn = active.conn;

    // Which mailbox is actually being polled? (diagnostic)
    let connectedMailbox = "unknown";
    try {
      const prof = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const pd = await prof.json();
      connectedMailbox = pd.emailAddress || "unknown";
    } catch (_) { /* ignore */ }

    // Build the set of internal senders that must NOT create support tickets:
    // our own connected mailboxes + every system user's email. Combined with
    // an own-domain check below, this stops staff emails (e.g. peter@serv-os.app)
    // from being treated as customer tickets.
    const internalEmails = new Set<string>();
    const [{ data: conns }, { data: profs }] = await Promise.all([
      supabase.from("gmail_connections").select("email"),
      supabase.from("profiles").select("email"),
    ]);
    (conns || []).forEach((c: any) => c.email && internalEmails.add(c.email.toLowerCase()));
    (profs || []).forEach((p: any) => p.email && internalEmails.add(p.email.toLowerCase()));

    // Own domain is derived from the connected support mailbox (e.g.
    // support@posup.co.uk -> posup.co.uk), so staff emailing in from their own
    // company domain never create tickets — no per-instance hardcoding needed.
    const OWN_DOMAINS = ["serv-os.app", "servos.app"];
    const mailboxDomain = (conn.email || "").toLowerCase().split("@")[1];
    if (mailboxDomain && !OWN_DOMAINS.includes(mailboxDomain)) OWN_DOMAINS.push(mailboxDomain);
    const isInternalSender = (email: string) => {
      const e = (email || "").toLowerCase().trim();
      if (!e) return true; // no sender -> skip
      if (internalEmails.has(e)) return true;
      const domain = e.split("@")[1] || "";
      return OWN_DOMAINS.includes(domain);
    };

    // Mail since the last poll (watermark). Re-poll with a 5-min overlap so a
    // message arriving mid-run is never skipped; message-id dedup handles the
    // overlap. Advance the watermark only after a clean pass.
    const sinceMs = conn.last_polled_at ? new Date(conn.last_polled_at).getTime() : Date.now();
    const afterEpoch = Math.floor((sinceMs - 5 * 60 * 1000) / 1000);
    const runStarted = new Date().toISOString();
    const messages = await getGmailMessages(accessToken, afterEpoch);
    let processed = 0;

    for (const msg of messages) {
      const full = await getGmailMessage(accessToken, msg.id);
      const headers = full.payload?.headers || [];

      const from = decodeMimeWords(getHeader(headers, "From"));
      const subject = decodeMimeWords(getHeader(headers, "Subject"));
      const messageId = getHeader(headers, "Message-ID");
      const inReplyTo = getHeader(headers, "In-Reply-To");
      const references = getHeader(headers, "References");
      const gmailThreadId = full.threadId;
      const date = getHeader(headers, "Date");

      const senderEmail = extractEmail(from);
      const senderName = extractName(from);

      // Skip emails from internal senders: our own connected mailbox, any
      // system user (e.g. peter@serv-os.app), or anything on our own domain.
      // These are staff, not customers, so they must not create tickets.
      if (isInternalSender(senderEmail)) {
        continue;
      }

      // Check if we already processed this message (dedup across overlapping polls)
      const { data: existing } = await supabase
        .from("crm_activities")
        .select("id")
        .eq("message_id", messageId)
        .limit(1);

      if (existing && existing.length > 0) {
        continue;
      }

      // Try to find existing ticket by Gmail thread ID
      let ticketId: string | null = null;
      const { data: threadMatch } = await supabase
        .from("ticket_email_threads")
        .select("ticket_id")
        .eq("email_thread_id", gmailThreadId)
        .limit(1);

      if (threadMatch && threadMatch.length > 0) {
        ticketId = threadMatch[0].ticket_id;

        // Reopen ticket if it was resolved/closed
        const { data: ticket } = await supabase
          .from("tickets")
          .select("stage")
          .eq("id", ticketId)
          .single();

        if (ticket && ["resolved", "closed"].includes(ticket.stage)) {
          await supabase
            .from("tickets")
            .update({ stage: "in_progress" })
            .eq("id", ticketId);

          await supabase.from("stage_history").insert({
            object_type: "ticket",
            object_id: ticketId,
            from_stage: ticket.stage,
            to_stage: "in_progress",
          });
        }
      }

      // Try to match sender to a contact
      let contactId: string | null = null;
      let companyId: string | null = null;

      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email")
        .ilike("email", senderEmail)
        .limit(1);

      if (contacts && contacts.length > 0) {
        contactId = contacts[0].id;

        // Find company via associations
        const { data: assocs } = await supabase
          .from("associations")
          .select("to_id")
          .eq("from_type", "contact")
          .eq("from_id", contactId)
          .eq("to_type", "company")
          .limit(1);

        if (assocs && assocs.length > 0) {
          companyId = assocs[0].to_id;
        }
      }

      // Create ticket if no thread match
      if (!ticketId) {
        const ticketData: any = {
          subject: subject || "Email from " + senderEmail,
          description: null,
          channel: "email",
          customer_email: senderEmail,
          contact_id: contactId,
          source: "email",
        };
        if (companyId) ticketData.company_id = companyId;

        const { data: newTicket, error: ticketErr } = await supabase
          .from("tickets")
          .insert(ticketData)
          .select()
          .single();

        if (ticketErr) console.error("Ticket create error:", ticketErr);

        if (newTicket) {
          ticketId = newTicket.id;

          // Write stage history
          await supabase.from("stage_history").insert({
            object_type: "ticket",
            object_id: ticketId,
            from_stage: null,
            to_stage: "new",
          });

          // Link contact to ticket
          if (contactId) {
            await supabase.from("associations").insert({
              from_type: "ticket",
              from_id: ticketId,
              to_type: "contact",
              to_id: contactId,
              label: "primary_contact",
            });
          }

          // Store thread mapping
          await supabase.from("ticket_email_threads").insert({
            ticket_id: ticketId,
            email_thread_id: gmailThreadId,
          });

          // Auto-reply on first contact only
          try {
            const { data: vs } = await supabase.from("support_settings")
              .select("auto_reply_email_enabled, auto_reply_email_subject, auto_reply_email_message, after_hours_email_subject, after_hours_email_message, business_hours_enabled, business_timezone, business_hours")
              .eq("id", 1).single();
            if (vs?.auto_reply_email_enabled) {
              const afterHours = !isOpenNow(vs) && !!(vs.after_hours_email_message || "").trim();
              const tmpl = afterHours ? vs.after_hours_email_message : vs.auto_reply_email_message;
              const replyBody = (tmpl || "")
                .replace(/\{\{\s*contact_name\s*\}\}/g, senderName || "there")
                .replace(/\{\{\s*ticket_number\s*\}\}/g, newTicket.ticket_number ? `#${newTicket.ticket_number}` : "");
              const replySubject = (afterHours ? (vs.after_hours_email_subject || vs.auto_reply_email_subject) : vs.auto_reply_email_subject) || "We received your message";
              const fromAddr = connectedMailbox && connectedMailbox !== "unknown" ? connectedMailbox : senderEmail;
              const ok = await sendGmailReply(accessToken, {
                from: fromAddr, to: senderEmail, subject: replySubject, body: replyBody,
                inReplyTo: messageId, references: references || messageId, threadId: gmailThreadId,
              });
              if (ok) {
                await supabase.from("crm_activities").insert({
                  type: "email", subject: replySubject, body: replyBody,
                  subject_type: "ticket", subject_id: ticketId, direction: "outbound",
                  is_internal: false, thread_id: gmailThreadId,
                  channel_metadata: { auto_reply: true, to: senderEmail },
                });
              }
            }
          } catch (e) {
            console.error("Auto-reply email failed:", e);
          }
        }
      }

      // Create activity
      if (ticketId) {
        const body = decodeBody(full.payload);

        await supabase.from("crm_activities").insert({
          type: "email",
          subject: subject,
          body: body.slice(0, 10000), // Limit body length
          subject_type: "ticket",
          subject_id: ticketId,
          direction: "inbound",
          contact_id: contactId,
          message_id: messageId,
          in_reply_to: inReplyTo || null,
          thread_id: gmailThreadId,
          is_internal: false,
          channel_metadata: {
            from: from,
            gmail_message_id: msg.id,
            gmail_thread_id: gmailThreadId,
          },
          occurred_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        });

        processed++;
      }

      // NB: we no longer mark the message read in Gmail — this is a shared
      // mailbox that staff also triage, so we leave their read/unread state
      // alone. The watermark + message-id dedup prevent re-processing.
    }

    // Advance the watermark to when this run started, so the next poll only
    // looks at newer mail. (Only on success; an early throw keeps the old mark.)
    await supabase.from("gmail_connections").update({ last_polled_at: runStarted }).eq("id", conn.id);

    return new Response(
      JSON.stringify({ success: true, processed, total: messages.length, connected_mailbox: connectedMailbox }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Gmail check error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
