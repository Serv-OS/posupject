// Twilio Voice Incoming Call Handler
// Webhook called when someone dials a support number — either line. The number
// they dialled (To) picks the region: its hours in its own timezone, its voice,
// its greeting and voicemail wording. One deployed function serves every line.
// Outbound (browser softphone) legs pick the caller ID by the destination's
// country prefix, so US customers see a +1 number, UK customers a +44 one.
//
// Required secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
// TWILIO_FROM_NUMBER remains the last-resort caller ID when no region has a number.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isOpenNow } from "../_shared/hours.ts";
import { phoneVariants } from "../_shared/phone.ts";
import { loadRegions, regionForTwilioNumber, effective, fromNumberFor } from "../_shared/region.ts";

// Escape text for safe inclusion inside a TwiML <Say>
const xmlEscape = (s: string) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

serve(async (req) => {
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

    // Parse Twilio webhook (form-urlencoded)
    const formData = await req.formData();
    const from = formData.get("From") as string;
    const to = formData.get("To") as string;
    const callSid = formData.get("CallSid") as string;
    const direction = formData.get("Direction") as string;

    console.log(`Call: from=${from}, to=${to}, direction=${direction}, SID: ${callSid}`);

    const regions = await loadRegions(supabase);

    // OUTBOUND CALL: agent dialing from browser
    // When a Twilio Client makes an outbound call, "From" starts with "client:"
    // and "To" is the phone number they want to call
    if (from?.startsWith("client:") || direction === "outbound") {
      const dialTo = to || formData.get("To") as string;
      // The line matching where the customer is: +1 → the US number, +44 → the
      // UK one. A +44 caller ID on a US handset is flagged or blocked by many
      // US carriers, so this is deliverability, not cosmetics.
      const callerId = fromNumberFor(regions, dialTo, Deno.env.get("TWILIO_FROM_NUMBER") || "");

      console.log(`Outbound call to ${dialTo} from ${callerId}`);

      let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';
      twiml += `<Dial callerId="${callerId}">`;
      twiml += `<Number>${xmlEscape(dialTo)}</Number>`;
      twiml += `</Dial>`;
      twiml += '</Response>';

      return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
    }

    // INBOUND CALL: customer calling one of the support numbers

    // Skip if this is a client-originated call that already went through outbound
    if (from?.startsWith("client:")) {
      console.log("Skipping client-originated inbound leg");
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    // Which line did they call? That decides hours, voice, and wording below.
    const region = regionForTwilioNumber(regions, to);

    // Every stored format this caller's number could match — UK and US shapes
    // both covered (the old expansion was +44-only, so a +1 caller could never
    // match a contact and every US call minted a fresh ticket).
    const rawFrom = from?.replace(/\s/g, "") || "";
    const variants = phoneVariants(rawFrom);

    // Match caller to a contact using all phone variants
    let contactId: string | null = null;
    let companyId: string | null = null;
    let callerName = from;

    if (variants.length > 0) {
      const phoneFilter = variants.map(p => `phone.eq.${p}`).join(",");
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, phone")
        .or(phoneFilter)
        .limit(1);

      if (contacts && contacts.length > 0) {
        contactId = contacts[0].id;
        callerName = [contacts[0].first_name, contacts[0].last_name].filter(Boolean).join(" ") || from;

        // Get company from contact's associations
        const { data: companyAssocs } = await supabase
          .from("associations")
          .select("to_id")
          .eq("from_type", "contact")
          .eq("from_id", contactId)
          .eq("to_type", "company")
          .limit(1);

        if (companyAssocs && companyAssocs.length > 0) {
          companyId = companyAssocs[0].to_id;
        }

        console.log(`Matched contact: ${callerName} (${contactId}), company: ${companyId}`);
      }
    }

    // Find online agents
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: onlineAgents } = await supabase
      .from("agent_status")
      .select("profile_id, twilio_identity, status")
      .eq("status", "online")
      .gte("last_seen_at", fiveMinAgo)
      .order("last_seen_at", { ascending: true });

    // Find or create a ticket for this caller
    let ticketId: string | null = null;
    const normalizedFrom = rawFrom;

    if (normalizedFrom) {
      // Search for open tickets matching any phone variant
      const ticketPhoneFilter = variants.map(p => `customer_phone.eq.${p}`).join(",");
      const { data: openTickets } = await supabase
        .from("tickets")
        .select("id")
        .or(ticketPhoneFilter)
        .not("stage", "in", '("closed")')
        .order("updated_at", { ascending: false })
        .limit(1);

      if (openTickets && openTickets.length > 0) {
        ticketId = openTickets[0].id;
        // The line they used most recently is the one replies should go from.
        if (to) await supabase.from("tickets").update({ service_number: to }).eq("id", ticketId);
      } else {
        // Create a new ticket
        const ticketData: any = {
          subject: `Call from ${callerName}`,
          channel: "phone",
          customer_phone: normalizedFrom,
          contact_id: contactId,
          source: "phone",
          service_number: to || null,
        };
        if (companyId) ticketData.company_id = companyId;

        const { data: newTicket, error: ticketErr } = await supabase
          .from("tickets")
          .insert(ticketData)
          .select()
          .single();

        if (ticketErr) {
          console.error("Ticket create error:", ticketErr);
        }

        if (newTicket) {
          ticketId = newTicket.id;
          await supabase.from("stage_history").insert({
            object_type: "ticket", object_id: ticketId,
            from_stage: null, to_stage: "new",
          });

          // Link contact to ticket via association
          if (contactId) {
            await supabase.from("associations").insert({
              from_type: "ticket",
              from_id: ticketId,
              to_type: "contact",
              to_id: contactId,
              label: "primary_contact",
            });
          }
        }
      }
    }

    // Store call SID for status callback tracking
    if (ticketId) {
      await supabase.from("crm_activities").insert({
        type: "call",
        subject: `Incoming call from ${callerName}`,
        subject_type: "ticket",
        subject_id: ticketId,
        direction: "inbound",
        message_id: callSid,
        is_internal: false,
        channel_metadata: {
          from_number: from,
          to_number: to,
          call_sid: callSid,
          status: "ringing",
          region: region?.code || null,
        },
      });
    }

    // Greeting + hours + voice: the region's own where one is set, the global
    // settings row otherwise — a deployment with no regions behaves as before.
    const { data: settingsRow } = await supabase.from("support_settings")
      .select("voice_greeting, voicemail_prompt, after_hours_voicemail_prompt, business_hours_enabled, business_timezone, business_hours, voice_id").eq("id", 1).single();
    const vs = effective(region, settingsRow);
    const open = isOpenNow(vs);
    const voice = vs?.voice_id || "Polly.Joanna-Neural";
    const greeting = xmlEscape(vs?.voice_greeting || "Please hold while we connect you to an agent.");
    const vmPrompt = xmlEscape((!open && vs?.after_hours_voicemail_prompt) || vs?.voicemail_prompt || "Please leave a message after the beep and we'll get back to you.");

    // Build TwiML response. Downstream callbacks can't see To, so carry the
    // region with them — their voicemail wording must match this line's.
    const FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    const regionParam = region ? `&region=${region.code}` : "";
    let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';

    if (open && onlineAgents && onlineAgents.length > 0) {
      // Ring online agents; record the call; on no-answer fall through to voicemail
      twiml += `<Say voice="${voice}">${greeting}</Say>`;
      twiml += `<Dial timeout="25" record="record-from-answer"`;
      twiml += ` recordingStatusCallback="${FN}/twilio-recording" recordingStatusCallbackEvent="completed"`;
      twiml += ` action="${FN}/twilio-voice-status?ticket=${ticketId || ""}${regionParam}"`;
      twiml += ` callerId="${to}">`;

      for (const agent of onlineAgents.slice(0, 3)) {
        // Ring up to 3 agents simultaneously
        twiml += `<Client>`;
        twiml += `<Identity>${agent.twilio_identity}</Identity>`;
        // A contact called 'Smith & Sons' must not produce invalid XML — Twilio
        // answers a parse error with the application-error message, killing
        // the call for that customer every single time.
        twiml += `<Parameter name="callerName" value="${xmlEscape(callerName)}"/>`;
        twiml += `<Parameter name="callerNumber" value="${xmlEscape(from)}"/>`;
        twiml += `</Client>`;
      }

      twiml += `</Dial>`;
    } else {
      // No agents online - go straight to voicemail (recorded + transcribed)
      twiml += `<Say voice="${voice}">${vmPrompt}</Say>`;
      twiml += `<Record maxLength="120" playBeep="true" transcribe="true"`;
      twiml += ` transcribeCallback="${FN}/twilio-voicemail?mode=transcription"`;
      twiml += ` action="${FN}/twilio-voicemail?ticket=${ticketId || ""}${regionParam}" />`;
      twiml += `<Say voice="${voice}">We didn't receive a message. Goodbye.</Say>`;
    }

    twiml += '</Response>';

    return new Response(twiml, {
      headers: { "Content-Type": "text/xml" },
    });
  } catch (error) {
    console.error("Voice incoming error:", error);
    // Fallback TwiML
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, we are experiencing technical difficulties. Please try again later.</Say></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
});
