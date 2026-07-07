// Gmail Send - Sends email reply from support@serv-os.app via Gmail API
// Called by frontend when agent sends an email from a ticket
//
// Required Supabase Secrets:
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAccessToken(supabase: any): Promise<string> {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET")!;

  // Read refresh token from database (in-app OAuth connection)
  const { data: conn } = await supabase
    .from("gmail_connections")
    .select("refresh_token")
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
  return data.access_token;
}

function createMimeMessage(to: string, subject: string, body: string, inReplyTo?: string, references?: string, threadId?: string): string {
  const boundary = "boundary_" + crypto.randomUUID().replace(/-/g, "");
  const messageId = `<${crypto.randomUUID()}@serv-os.app>`;

  let headers = [
    `From: ServOS Support <support@serv-os.app>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Message-ID: ${messageId}`,
  ];

  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);

  const raw = headers.join("\r\n") + "\r\n\r\n" + body;

  // Base64url encode
  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return encoded;
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

    const { ticket_id, to, subject, body, cc } = await req.json();

    if (!ticket_id || !to || !body) {
      return new Response(JSON.stringify({ error: "Missing required fields: ticket_id, to, body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
      .select("message_id, thread_id")
      .eq("subject_type", "ticket")
      .eq("subject_id", ticket_id)
      .eq("type", "email")
      .eq("direction", "inbound")
      .order("occurred_at", { ascending: false })
      .limit(1);

    const inReplyTo = lastMessage?.[0]?.message_id || undefined;
    const references = inReplyTo || undefined;

    // Build and send email via Gmail API
    const accessToken = await getAccessToken(supabase);
    const _base = (ticket?.subject || "").replace(/^\s*(re:\s*)+/i, "").trim();
    const emailSubject = subject || (_base ? `Re: ${_base}` : "Support reply");
    const rawMessage = createMimeMessage(to, emailSubject, body, inReplyTo, references);

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
    const newMessageId = `<${crypto.randomUUID()}@serv-os.app>`;

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
        to: to,
        cc: cc || null,
        from: "support@serv-os.app",
        gmail_message_id: sendResult.id,
        gmail_thread_id: sendResult.threadId,
      },
    }).select().single();

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
