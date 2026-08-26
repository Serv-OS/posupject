// Twilio Voice Status Callback
// Called when call status changes (completed, no-answer, busy, failed)
// Updates the activity record with duration and outcome

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { phoneVariants } from "../_shared/phone.ts";
import { loadRegions, regionByCode, effective } from "../_shared/region.ts";

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

    const formData = await req.formData();
    const callSid = (formData.get("CallSid") || formData.get("DialCallSid")) as string;
    const callStatus = formData.get("CallStatus") as string;
    const callDuration = formData.get("CallDuration") as string;
    const recordingUrl = formData.get("RecordingUrl") as string;
    const dialCallStatus = formData.get("DialCallStatus") as string;

    const status = dialCallStatus || callStatus || "unknown";
    const duration = parseInt(callDuration || "0");

    console.log(`Call status update: SID=${callSid}, status=${status}, duration=${duration}s`);

    // Update the activity record
    if (callSid) {
      const { data: activity } = await supabase
        .from("crm_activities")
        .select("id, channel_metadata")
        .eq("message_id", callSid)
        .limit(1)
        .single();

      if (activity) {
        const metadata = activity.channel_metadata || {};
        metadata.status = status;
        metadata.duration_seconds = duration;
        if (recordingUrl) metadata.recording_url = recordingUrl;

        // Map Twilio status to outcome
        let outcome = "connected";
        if (status === "no-answer") outcome = "no_answer";
        else if (status === "busy") outcome = "busy";
        else if (status === "failed" || status === "canceled") outcome = "failed";
        else if (status === "completed") outcome = "connected";

        metadata.outcome = outcome;

        await supabase
          .from("crm_activities")
          .update({
            channel_metadata: metadata,
            body: `Call ${outcome.replace("_", " ")}${duration > 0 ? ` (${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, "0")})` : ""}`,
          })
          .eq("id", activity.id);
      }
    }

    // If call was not answered, create a missed call ticket/update
    if (status === "no-answer" || status === "busy") {
      const from = formData.get("From") as string;
      if (from) {
        // Update existing ticket to note the missed call
        // Match on every stored shape of the number, not the exact string —
        // this branch had no variants at all, so it missed for UK and US alike.
        const variants = phoneVariants(from);
        const { data: tickets } = await supabase
          .from("tickets")
          .select("id")
          .or(variants.map((p) => `customer_phone.eq.${p}`).join(","))
          .not("stage", "in", '("closed")')
          .limit(1);

        if (tickets && tickets.length > 0) {
          await supabase.from("crm_activities").insert({
            type: "call",
            subject: "Missed call",
            body: `Customer called but no agent was available (${status})`,
            subject_type: "ticket",
            subject_id: tickets[0].id,
            direction: "inbound",
            is_internal: true,
            channel_metadata: { status, outcome: status === "busy" ? "busy" : "no_answer" },
          });
        }
      }
    }

    // If the dial wasn't answered, offer voicemail (recorded + transcribed).
    if (status === "no-answer" || status === "busy" || status === "failed") {
      const FN = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
      const params = new URL(req.url).searchParams;
      const ticketId = params.get("ticket") || "";
      // The dial handler stamped which line this call came in on; keep the
      // voicemail in that line's voice and wording.
      const regionCode = params.get("region");
      const { data: settingsRow } = await supabase.from("support_settings").select("voicemail_prompt, voice_id").eq("id", 1).single();
      const vs = effective(regionByCode(await loadRegions(supabase), regionCode), settingsRow);
      const voice = vs?.voice_id || "Polly.Joanna-Neural";
      const vmPrompt = (vs?.voicemail_prompt || "Sorry, we couldn't reach an agent. Please leave a message after the beep.")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        `<Say voice="${voice}">${vmPrompt}</Say>` +
        `<Record maxLength="120" playBeep="true" transcribe="true"` +
        ` transcribeCallback="${FN}/twilio-voicemail?mode=transcription"` +
        ` action="${FN}/twilio-voicemail?ticket=${ticketId}${regionCode ? `&region=${regionCode}` : ""}" />` +
        `<Say voice="${voice}">We didn't receive a message. Goodbye.</Say>` +
        `</Response>`,
        { headers: { "Content-Type": "text/xml" } }
      );
    }

    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  } catch (error) {
    console.error("Voice status error:", error);
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
      { headers: { "Content-Type": "text/xml" } }
    );
  }
});
