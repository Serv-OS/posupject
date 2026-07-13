// Twilio voicemail handler.
//   POST ?ticket=<id>            -> the <Record> action: caller left a voicemail.
//        Logs a voicemail activity on the ticket and returns a goodbye message.
//   POST ?mode=transcription     -> transcribeCallback: attaches the transcript
//        to the voicemail activity (matched by RecordingSid).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "Content-Type": "text/xml" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode");
    const ticketParam = url.searchParams.get("ticket");
    const form = await req.formData();

    // --- Transcription callback: attach text to the voicemail activity ---
    if (mode === "transcription") {
      const recordingSid = form.get("RecordingSid") as string;
      const text = (form.get("TranscriptionText") as string) || "";
      if (recordingSid) {
        const { data: act } = await supabase
          .from("crm_activities")
          .select("id, channel_metadata")
          .eq("message_id", recordingSid)
          .limit(1)
          .single();
        if (act) {
          const md = act.channel_metadata || {};
          md.transcription = text;
          await supabase.from("crm_activities").update({
            channel_metadata: md,
            body: text ? `Voicemail: "${text}"` : "Voicemail (no transcription available)",
          }).eq("id", act.id);
        }
      }
      return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
    }

    // --- Record action: a voicemail was left ---
    const from = form.get("From") as string;
    const callSid = form.get("CallSid") as string;
    const recordingSid = form.get("RecordingSid") as string;
    const recordingDuration = parseInt((form.get("RecordingDuration") as string) || "0");

    // Resolve the ticket (passed through from the dial flow, else find by phone)
    let ticketId: string | null = ticketParam;
    let contactId: string | null = null;
    const normFrom = (from || "").replace(/\s/g, "");

    if (!ticketId && normFrom) {
      const variants = [normFrom];
      if (normFrom.startsWith("+44")) { variants.push("0" + normFrom.slice(3)); variants.push(normFrom.slice(1)); }
      if (normFrom.startsWith("0")) { variants.push("+44" + normFrom.slice(1)); variants.push("44" + normFrom.slice(1)); }
      const filter = variants.map(p => `customer_phone.eq.${p}`).join(",");
      const { data: t } = await supabase.from("tickets").select("id").or(filter).not("stage", "in", '("closed")').order("updated_at", { ascending: false }).limit(1);
      if (t && t.length) ticketId = t[0].id;
    }

    // Look up contact for naming
    let callerName = from;
    if (normFrom) {
      const { data: c } = await supabase.from("contacts").select("id, first_name, last_name").eq("phone", normFrom).limit(1);
      if (c && c.length) { contactId = c[0].id; callerName = [c[0].first_name, c[0].last_name].filter(Boolean).join(" ") || from; }
    }

    // Create a ticket if we still don't have one (voicemail with no prior ticket)
    if (!ticketId) {
      const { data: nt } = await supabase.from("tickets").insert({
        subject: `Voicemail from ${callerName}`,
        channel: "phone",
        customer_phone: normFrom || null,
        contact_id: contactId,
        source: "voicemail",
      }).select("id").single();
      ticketId = nt?.id || null;
      if (ticketId) {
        await supabase.from("stage_history").insert({ object_type: "ticket", object_id: ticketId, from_stage: null, to_stage: "new" });
        if (contactId) await supabase.from("associations").insert({ from_type: "ticket", from_id: ticketId, to_type: "contact", to_id: contactId, label: "primary_contact" });
      }
    } else {
      // Reopen the ticket if it had been resolved
      await supabase.from("tickets").update({ stage: "new" }).eq("id", ticketId).in("stage", ["resolved"]);
    }

    if (ticketId && recordingSid) {
      await supabase.from("crm_activities").insert({
        type: "call",
        subject: `Voicemail from ${callerName}`,
        body: `Voicemail (${recordingDuration}s) — transcription pending…`,
        subject_type: "ticket",
        subject_id: ticketId,
        direction: "inbound",
        contact_id: contactId,
        message_id: recordingSid, // transcription callback matches on this
        is_internal: false,
        channel_metadata: {
          kind: "voicemail",
          from_number: from,
          call_sid: callSid,
          recording_sid: recordingSid,
          recording_duration: recordingDuration,
          status: "voicemail",
          outcome: "voicemail",
        },
      });
    }

    const { data: vsV } = await supabase.from("support_settings").select("voice_id").eq("id", 1).single();
    const voice = vsV?.voice_id || "Polly.Joanna-Neural";
    return xml(`<Say voice="${voice}">Thank you. We've received your message and will get back to you shortly. Goodbye.</Say><Hangup/>`);
  } catch (e) {
    console.error("voicemail error:", e);
    return xml(`<Say voice="Polly.Joanna-Neural">Thank you for your message. Goodbye.</Say><Hangup/>`);
  }
});
