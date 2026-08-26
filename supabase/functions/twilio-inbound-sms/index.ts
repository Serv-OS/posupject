// Twilio Inbound SMS Webhook
// Receives SMS from customers, creates/threads into support tickets
// Configure in Twilio: set webhook URL to this function
//
// Required Supabase Secrets: TWILIO_AUTH_TOKEN (for signature validation)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isOpenNow } from "../_shared/hours.ts";
import { phoneVariants } from "../_shared/phone.ts";
import { loadRegions, regionForTwilioNumber, effective } from "../_shared/region.ts";

serve(async (req) => {
  // Twilio sends webhooks as POST with form-urlencoded body
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Parse Twilio webhook payload (form-urlencoded)
    const formData = await req.formData();
    const from = formData.get("From") as string; // e.g. +447123456789
    const to = formData.get("To") as string;     // e.g. +447576562085
    const body = formData.get("Body") as string;
    const messageSid = formData.get("MessageSid") as string;

    if (!from || !body) {
      return twimlResponse("Missing required fields");
    }

    // Normalize phone number (ensure +44 format)
    const normalizedFrom = from.replace(/\s/g, "");

    // Check if we already processed this message
    const { data: existing } = await supabase
      .from("crm_activities")
      .select("id")
      .eq("message_id", messageSid)
      .limit(1);

    if (existing && existing.length > 0) {
      return twimlResponse(""); // Already processed, return empty TwiML
    }

    // Every stored shape of this number — UK and US formats both covered.
    const variants = phoneVariants(normalizedFrom);
    // Which of our lines was texted; that region owns the auto-reply wording.
    const region = regionForTwilioNumber(await loadRegions(supabase), to);

    // Try to match sender to a contact by phone number
    let contactId: string | null = null;
    let companyId: string | null = null;
    let contactName = normalizedFrom;

    const phoneFilter = variants.map(p => `phone.eq.${p}`).join(",");
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, phone")
      .or(phoneFilter)
      .limit(1);

    if (contacts && contacts.length > 0) {
      contactId = contacts[0].id;
      contactName = [contacts[0].first_name, contacts[0].last_name].filter(Boolean).join(" ") || normalizedFrom;

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

    // Find existing open ticket for this phone number
    let ticketId: string | null = null;
    let isNewTicket = false;
    let ticketNumber: number | null = null;

    const { data: openTickets } = await supabase
      .from("tickets")
      .select("id, stage")
      .or(variants.map((p) => `customer_phone.eq.${p}`).join(","))
      .eq("channel", "sms")
      .not("stage", "in", '("closed")')
      .order("updated_at", { ascending: false })
      .limit(1);

    if (openTickets && openTickets.length > 0) {
      ticketId = openTickets[0].id;
      // Replies must leave from the line the customer texted, and the latest
      // line they used wins.
      if (to) await supabase.from("tickets").update({ service_number: to }).eq("id", ticketId);

      // Reopen if resolved
      if (openTickets[0].stage === "resolved") {
        await supabase.from("tickets").update({ stage: "in_progress" }).eq("id", ticketId);
        await supabase.from("stage_history").insert({
          object_type: "ticket", object_id: ticketId,
          from_stage: "resolved", to_stage: "in_progress",
        });
      }
    }

    // Create new ticket if no open one exists
    if (!ticketId) {
      const ticketData: any = {
        subject: `SMS from ${contactName}`,
        description: body.slice(0, 200),
        channel: "sms",
        customer_phone: normalizedFrom,
        contact_id: contactId,
        source: "sms",
        service_number: to || null,
      };
      if (companyId) ticketData.company_id = companyId;

      const { data: newTicket, error: ticketError } = await supabase
        .from("tickets")
        .insert(ticketData)
        .select()
        .single();

      if (ticketError) {
        console.error("Ticket create error:", ticketError);
      }

      if (newTicket) {
        ticketId = newTicket.id;
        isNewTicket = true;
        ticketNumber = newTicket.ticket_number ?? null;

        await supabase.from("stage_history").insert({
          object_type: "ticket", object_id: ticketId,
          from_stage: null, to_stage: "new",
        });

        // Link contact to ticket
        if (contactId) {
          await supabase.from("associations").insert({
            from_type: "ticket", from_id: ticketId,
            to_type: "contact", to_id: contactId,
            label: "primary_contact",
          });
        }
      }
    }

    // Create activity
    if (ticketId) {
      await supabase.from("crm_activities").insert({
        type: "sms",
        body: body,
        subject_type: "ticket",
        subject_id: ticketId,
        direction: "inbound",
        contact_id: contactId,
        message_id: messageSid,
        thread_id: ticketId, // All SMS on a ticket share the ticket as thread
        is_internal: false,
        channel_metadata: {
          from_number: normalizedFrom,
          to_number: to,
          twilio_sid: messageSid,
        },
      });
    }

    // Auto-reply on first contact only (avoid replying to every message).
    // The TwiML response goes out from the number that was texted, so this
    // path is dual-number correct by construction — only the WORDING and the
    // out-of-hours check are per region.
    if (isNewTicket) {
      const { data: settingsRow } = await supabase.from("support_settings")
        .select("auto_reply_sms_enabled, auto_reply_sms_message, business_hours_enabled, business_timezone, business_hours").eq("id", 1).single();
      const vs = effective(region, settingsRow);
      const afterHours = !isOpenNow(vs) && vs?.after_hours_sms_message;
      const template = afterHours ? vs.after_hours_sms_message : vs?.auto_reply_sms_message;
      if (settingsRow?.auto_reply_sms_enabled && template) {
        const reply = template
          .replace(/\{\{\s*contact_name\s*\}\}/g, contactName || "there")
          .replace(/\{\{\s*ticket_number\s*\}\}/g, ticketNumber ? `#${ticketNumber}` : "")
          .trim();
        // Log the auto-reply as an outbound activity
        if (ticketId) {
          await supabase.from("crm_activities").insert({
            type: "sms", body: reply, subject_type: "ticket", subject_id: ticketId,
            direction: "outbound", is_internal: false,
            channel_metadata: { auto_reply: true, to_number: normalizedFrom },
          });
        }
        return twimlResponse(reply);
      }
    }

    // No auto-reply: agents reply from the CRM
    return twimlResponse("");
  } catch (error) {
    console.error("Twilio inbound error:", error);
    return twimlResponse("");
  }
});

function xmlEscape(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function twimlResponse(message: string): Response {
  const twiml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

  return new Response(twiml, {
    headers: { "Content-Type": "text/xml" },
  });
}
