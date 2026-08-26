// Twilio Send SMS - Sends outbound SMS to customer from ticket context
// Called by frontend when agent sends SMS from a ticket
//
// Required Supabase Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toE164 } from "../_shared/phone.ts";
import { loadRegions, fromNumberFor } from "../_shared/region.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No auth" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify JWT
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { ticket_id, to, body } = await req.json();

    if (!ticket_id || !to || !body) {
      return new Response(JSON.stringify({ error: "Missing required fields: ticket_id, to, body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;

    // Twilio wants E.164; the UI passes whatever was typed on the ticket.
    const toClean = toE164(to) || to.trim();

    // Which line to send from, in order of authority:
    //  1. the line this conversation already lives on (stamped by the inbound
    //     webhooks) — replies must come from the number the customer texted
    //  2. the region matching the customer's country prefix
    //  3. the env secret, so an unconfigured deployment behaves as it always has
    const regions = await loadRegions(supabase);
    const { data: t0 } = await supabase.from("tickets").select("service_number").eq("id", ticket_id).maybeSingle();
    const fromNumber = t0?.service_number || fromNumberFor(regions, toClean, Deno.env.get("TWILIO_FROM_NUMBER") || "");
    if (!fromNumber) {
      return new Response(JSON.stringify({ error: "No sending number is configured. Add one in Settings → Regions." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Send via Twilio REST API
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const credentials = btoa(`${accountSid}:${authToken}`);

    const sendRes = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        To: toClean,
        From: fromNumber,
        Body: body,
      }),
    });

    const sendResult = await sendRes.json();

    if (!sendRes.ok) {
      return new Response(JSON.stringify({
        error: "Twilio send failed",
        details: sendResult.message || sendResult,
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create activity record
    await supabase.from("crm_activities").insert({
      type: "sms",
      body: body,
      subject_type: "ticket",
      subject_id: ticket_id,
      direction: "outbound",
      actor_id: user.id,
      message_id: sendResult.sid,
      thread_id: ticket_id,
      is_internal: false,
      channel_metadata: {
        to_number: toClean,
        from_number: fromNumber,
        twilio_sid: sendResult.sid,
        segments: sendResult.num_segments,
      },
    });

    // Update ticket stage if new
    const { data: ticket } = await supabase
      .from("tickets")
      .select("stage")
      .eq("id", ticket_id)
      .single();

    if (ticket?.stage === "new") {
      await supabase.from("tickets").update({ stage: "waiting_on_customer" }).eq("id", ticket_id);
      await supabase.from("stage_history").insert({
        object_type: "ticket", object_id: ticket_id,
        from_stage: "new", to_stage: "waiting_on_customer",
        changed_by: user.id,
      });
    }

    return new Response(
      JSON.stringify({ success: true, twilio_sid: sendResult.sid }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Twilio send error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
