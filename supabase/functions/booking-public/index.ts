// booking-public — the customer's side of the booking page. No login: this is a
// public link, like Calendly.
//
// Actions: config (what to show) | slots (what is free) | book | cancel
//
// Availability is computed from THREE sources, and all three matter:
//   1. the host's working hours, in the host's own timezone
//   2. their Google calendar (so a real meeting blocks the slot)
//   3. bookings already taken through this page (Google can lag by seconds)
// The conflict check runs again at booking time, because the interesting race
// is two people looking at the same free slot at the same moment.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateSlots, type Busy } from "../_shared/slots.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function googleToken(supabase: any, hostEmail: string): Promise<{ token: string | null; integ: any }> {
  const { data: integ } = await supabase.from("user_integrations")
    .select("id, access_token, refresh_token, token_expires_at, email")
    .eq("provider", "google").ilike("email", hostEmail).maybeSingle();
  if (!integ?.refresh_token) return { token: null, integ: null };
  if (integ.access_token && integ.token_expires_at && new Date(integ.token_expires_at).getTime() - Date.now() > 60000) {
    return { token: integ.access_token, integ };
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GMAIL_CLIENT_ID")!,
      client_secret: Deno.env.get("GMAIL_CLIENT_SECRET")!,
      refresh_token: integ.refresh_token, grant_type: "refresh_token",
    }),
  });
  const t = await res.json();
  if (!t.access_token) { console.error("google refresh failed", JSON.stringify(t).slice(0, 200)); return { token: null, integ }; }
  await supabase.from("user_integrations").update({
    access_token: t.access_token,
    token_expires_at: new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString(),
  }).eq("id", integ.id);
  return { token: t.access_token, integ };
}

/** Busy periods from the host's calendar. Events they declined, or marked free,
 *  are not busy — otherwise a wall of "FYI" invitations blocks the whole week. */
async function googleBusy(token: string, fromIso: string, toIso: string, hostEmail: string): Promise<Busy[]> {
  const params = new URLSearchParams({
    timeMin: fromIso, timeMax: toIso, singleEvents: "true", orderBy: "startTime", maxResults: "250",
  });
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) { console.error("calendar read failed", r.status, (await r.text()).slice(0, 200)); return []; }
  const d = await r.json();
  const out: Busy[] = [];
  for (const ev of (d.items || [])) {
    if (ev.status === "cancelled") continue;
    if (ev.transparency === "transparent") continue;                   // "free"
    const me = (ev.attendees || []).find((a: any) => a.self || (a.email || "").toLowerCase() === hostEmail.toLowerCase());
    if (me?.responseStatus === "declined") continue;
    // All-day events (date, not dateTime) block the whole day.
    const start = ev.start?.dateTime ? Date.parse(ev.start.dateTime)
      : ev.start?.date ? Date.parse(ev.start.date + "T00:00:00Z") : null;
    const end = ev.end?.dateTime ? Date.parse(ev.end.dateTime)
      : ev.end?.date ? Date.parse(ev.end.date + "T00:00:00Z") : null;
    if (start && end) out.push({ start, end });
  }
  return out;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const action = String(body?.action || "config");
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── cancel needs only its token ──
  if (action === "cancel") {
    const tok = String(body?.cancel_token || "");
    const { data: bk } = await supabase.from("bookings").select("*").eq("cancel_token", tok).maybeSingle();
    if (!bk) return json({ error: "That booking link is not valid." }, 404);
    if (bk.status === "cancelled") return json({ ok: true, already: true });
    await supabase.from("bookings").update({ status: "cancelled", cancelled_at: new Date().toISOString() }).eq("id", bk.id);
    if (bk.google_event_id) {
      const { data: bt } = await supabase.from("booking_types").select("host_email").eq("id", bk.booking_type_id).maybeSingle();
      const { token } = await googleToken(supabase, bt?.host_email || "");
      if (token) {
        await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${bk.google_event_id}?sendUpdates=all`,
          { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      }
    }
    return json({ ok: true });
  }

  const slug = String(body?.slug || "").trim();
  const { data: bt } = await supabase.from("booking_types").select("*").eq("slug", slug).eq("active", true).maybeSingle();
  if (!bt) return json({ error: "This booking page is not available." }, 404);

  const cfg = {
    timezone: bt.timezone, hours: bt.hours || {},
    durationMins: bt.duration_mins, slotStepMins: bt.slot_step_mins,
    bufferMins: bt.buffer_mins, minNoticeHrs: bt.min_notice_hrs, maxDaysAhead: bt.max_days_ahead,
  };

  if (action === "config") {
    return json({
      name: bt.name, description: bt.description, durationMins: bt.duration_mins,
      hostTimezone: bt.timezone, maxDaysAhead: bt.max_days_ahead, questions: bt.questions || [],
    });
  }

  if (action === "slots") {
    const from = Math.max(Date.parse(String(body?.from)) || Date.now(), Date.now());
    const to = Math.min(
      Date.parse(String(body?.to)) || (Date.now() + bt.max_days_ahead * 86400000),
      Date.now() + bt.max_days_ahead * 86400000,
    );
    if (!(to > from)) return json({ slots: [] });

    const { token } = await googleToken(supabase, bt.host_email || "");
    let busy: Busy[] = [];
    let calendarOk = false;
    if (token) {
      busy = await googleBusy(token, new Date(from).toISOString(), new Date(to).toISOString(), bt.host_email || "");
      calendarOk = true;
    }
    // Bookings taken here count too, whether or not Google answered.
    const { data: taken } = await supabase.from("bookings")
      .select("starts_at, ends_at").eq("status", "confirmed")
      .lt("starts_at", new Date(to).toISOString()).gt("ends_at", new Date(from).toISOString());
    for (const t of (taken || [])) busy.push({ start: Date.parse(t.starts_at), end: Date.parse(t.ends_at) });

    const slots = generateSlots(cfg, busy, from, to, Date.now());
    return json({
      slots: slots.map((s) => new Date(s).toISOString()),
      durationMins: bt.duration_mins,
      // If the calendar could not be read we would be offering slots we cannot
      // vouch for, so the page says so rather than quietly overbooking.
      calendarOk,
    });
  }

  if (action === "book") {
    const startsAt = Date.parse(String(body?.slot || ""));
    const name = String(body?.name || "").trim();
    const email = String(body?.email || "").trim();
    if (!startsAt) return json({ error: "Pick a time first." }, 422);
    if (!name || !email.includes("@")) return json({ error: "Your name and a valid email are required." }, 422);
    const endsAt = startsAt + bt.duration_mins * 60000;

    // Re-check against everything, now. Two people can hold the same slot open.
    const { token } = await googleToken(supabase, bt.host_email || "");
    let busy: Busy[] = [];
    if (token) busy = await googleBusy(token, new Date(startsAt - 3600000).toISOString(), new Date(endsAt + 3600000).toISOString(), bt.host_email || "");
    const { data: taken } = await supabase.from("bookings")
      .select("starts_at, ends_at").eq("status", "confirmed")
      .lt("starts_at", new Date(endsAt).toISOString()).gt("ends_at", new Date(startsAt).toISOString());
    for (const t of (taken || [])) busy.push({ start: Date.parse(t.starts_at), end: Date.parse(t.ends_at) });

    const still = generateSlots(cfg, busy, startsAt, startsAt, Date.now());
    if (!still.includes(startsAt)) {
      return json({ error: "Sorry, that time has just been taken. Please pick another." }, 409);
    }

    const cancelToken = crypto.randomUUID().replace(/-/g, "");
    let googleEventId: string | null = null;
    if (token) {
      const ev = {
        summary: `${bt.name} — ${name}`,
        description: [
          body?.company ? `Company: ${body.company}` : "",
          body?.phone ? `Phone: ${body.phone}` : "",
          body?.notes ? `\n${body.notes}` : "",
          `\nBooked via the ${bt.name} page.`,
        ].filter(Boolean).join("\n"),
        start: { dateTime: new Date(startsAt).toISOString(), timeZone: bt.timezone },
        end: { dateTime: new Date(endsAt).toISOString(), timeZone: bt.timezone },
        attendees: [{ email, displayName: name }],
        // A Meet link means neither side has to arrange one, and the invite
        // Google sends is itself the customer's confirmation.
        conferenceData: { createRequest: { requestId: cancelToken.slice(0, 24), conferenceSolutionKey: { type: "hangoutsMeet" } } },
      };
      const r = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all&conferenceDataVersion=1",
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(ev) },
      );
      if (r.ok) { googleEventId = (await r.json()).id ?? null; }
      else console.error("calendar create failed", r.status, (await r.text()).slice(0, 300));
    }

    // Land it in the CRM: a booking nobody can find afterwards is half a feature.
    let contactId: string | null = null;
    const { data: existing } = await supabase.from("contacts").select("id").ilike("email", email).limit(1);
    if (existing?.length) contactId = existing[0].id;
    else {
      const parts = name.split(/\s+/);
      const { data: c } = await supabase.from("contacts").insert({
        first_name: parts[0] || name, last_name: parts.slice(1).join(" ") || null,
        email, phone: body?.phone || null, source: "booking",
      }).select("id").single();
      contactId = c?.id ?? null;
    }

    const { data: bk, error } = await supabase.from("bookings").insert({
      booking_type_id: bt.id, host_user_id: bt.host_user_id,
      starts_at: new Date(startsAt).toISOString(), ends_at: new Date(endsAt).toISOString(),
      booker_timezone: body?.timezone || null,
      name, email, phone: body?.phone || null, company: body?.company || null, notes: body?.notes || null,
      answers: body?.answers && typeof body.answers === "object" ? body.answers : {},
      google_event_id: googleEventId, cancel_token: cancelToken, contact_id: contactId,
    }).select("id").single();
    if (error) return json({ error: error.message }, 500);

    if (contactId) {
      await supabase.from("crm_activities").insert({
        type: "meeting", subject_type: "contact", subject_id: contactId, is_internal: true,
        subject: `${bt.name} booked`,
        body: [
          `${name} booked a ${bt.duration_mins} minute ${bt.name.toLowerCase()}.`,
          `When: ${new Date(startsAt).toISOString()}`,
          body?.company ? `Company: ${body.company}` : "",
          body?.notes ? `Notes: ${body.notes}` : "",
        ].filter(Boolean).join("\n"),
        occurred_at: new Date().toISOString(),
        channel_metadata: { kind: "booking", booking_id: bk?.id },
      });
    }

    return json({
      ok: true, id: bk?.id, cancel_token: cancelToken,
      starts_at: new Date(startsAt).toISOString(),
      calendarInvite: !!googleEventId,
    });
  }

  return json({ error: "Unknown action" }, 400);
});
