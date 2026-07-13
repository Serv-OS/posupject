// Twilio Voice Incoming Call Handler
// Webhook called when someone dials the support number
// Routes to online agents via Twilio Client, or plays voicemail message
//
// Required secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isOpenNow } from "../_shared/hours.ts";

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
    const callStatus = formData.get("CallStatus") as string;
    const direction = formData.get("Direction") as string;

    console.log(`Call: from=${from}, to=${to}, direction=${direction}, SID: ${callSid}`);

    // OUTBOUND CALL: agent dialing from browser
    // When a Twilio Client makes an outbound call, "From" starts with "client:"
    // and "To" is the phone number they want to call
    if (from?.startsWith("client:") || direction === "outbound") {
      const dialTo = to || formData.get("To") as string;
      const callerId = Deno.env.get("TWILIO_FROM_NUMBER") || "";

      console.log(`Outbound call to ${dialTo} from ${callerId}`);

      let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';
      twiml += `<Dial callerId="${callerId}">`;
      twiml += `<Number>${dialTo}</Number>`;
      twiml += `</Dial>`;
      twiml += '</Response>';

      return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
    }

    // INBOUND CALL: customer calling the support number

    // Skip if this is a client-originated call that already went through outbound
    if (from?.startsWith("client:")) {
      console.log("Skipping client-originated inbound leg");
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    // Normalize phone number and generate all possible formats for matching
    const rawFrom = from?.replace(/\s/g, "") || "";
    const phoneVariants: string[] = [];
    if (rawFrom) {
      phoneVariants.push(rawFrom);
      // +447xxx -> 07xxx and 447xxx
      if (rawFrom.startsWith("+44")) {
        phoneVariants.push("0" + rawFrom.slice(3));
        phoneVariants.push(rawFrom.slice(1)); // 447xxx
      }
      // 07xxx -> +447xxx and 447xxx
      if (rawFrom.startsWith("0")) {
        phoneVariants.push("+44" + rawFrom.slice(1));
        phoneVariants.push("44" + rawFrom.slice(1));
      }
      // +1xxx (US) -> just keep as is
    }

    // Match caller to a contact using all phone variants
    let contactId: string | null = null;
    let companyId: string | null = null;
    let callerName = from;

    if (phoneVariants.length > 0) {
      const phoneFilter = phoneVariants.map(p => `phone.eq.${p}`).join(",");
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
      const ticketPhoneFilter = phoneVariants.map(p => `customer_phone.eq.${p}`).join(",");
      const { data: openTickets } = await supabase
        .from("tickets")
        .select("id")
        .or(ticketPhoneFilter)
        .not("stage", "in", '("closed")')
        .order("updated_at", { ascending: false })
        .limit(1);

      if (openTickets && openTickets.length > 0) {
        ticketId = openTickets[0].id;
      } else {
        // Create a new ticket
        const ticketData: any = {
          subject: `Call from ${callerName}`,
          channel: "phone",
          customer_phone: normalizedFrom,
          contact_id: contactId,
          source: "phone",
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
        },
      });
    }

    // Editable greeting + voicemail prompt (from support_settings)
    const { data: vs } = await supabase.from("support_settings")
      .select("voice_greeting, voicemail_prompt, after_hours_voicemail_prompt, business_hours_enabled, business_timezone, business_hours, voice_id").eq("id", 1).single();
    const open = isOpenNow(vs);
    const voice = vs?.voice_id || "Polly.Joanna-Neural";
    const greeting = xmlEscape(vs?.voice_greeting || "Please hold while we connect you to an agent.");
    const vmPrompt = xmlEscape((!open && vs?.after_hours_voicemail_prompt) || vs?.voicemail_prompt || "Please leave a message after the beep and we'll get back to you.");

    // Build TwiML response
    const FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
    let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';

    if (open && onlineAgents && onlineAgents.length > 0) {
      // Ring online agents; record the call; on no-answer fall through to voicemail
      twiml += `<Say voice="${voice}">${greeting}</Say>`;
      twiml += `<Dial timeout="25" record="record-from-answer"`;
      twiml += ` recordingStatusCallback="${FN}/twilio-recording" recordingStatusCallbackEvent="completed"`;
      twiml += ` action="${FN}/twilio-voice-status?ticket=${ticketId || ""}"`;
      twiml += ` callerId="${to}">`;

      for (const agent of onlineAgents.slice(0, 3)) {
        // Ring up to 3 agents simultaneously
        twiml += `<Client>`;
        twiml += `<Identity>${agent.twilio_identity}</Identity>`;
        twiml += `<Parameter name="callerName" value="${callerName}"/>`;
        twiml += `<Parameter name="callerNumber" value="${from}"/>`;
        twiml += `</Client>`;
      }

      twiml += `</Dial>`;
    } else {
      // No agents online - go straight to voicemail (recorded + transcribed)
      twiml += `<Say voice="${voice}">${vmPrompt}</Say>`;
      twiml += `<Record maxLength="120" playBeep="true" transcribe="true"`;
      twiml += ` transcribeCallback="${FN}/twilio-voicemail?mode=transcription"`;
      twiml += ` action="${FN}/twilio-voicemail?ticket=${ticketId || ""}" />`;
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
