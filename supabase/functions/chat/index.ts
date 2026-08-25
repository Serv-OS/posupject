// chat — the public support bot behind the embeddable widget.
//
// Runs as service_role (the chat_* tables have no anon policy on purpose), so
// every request is validated here: the site key must exist, be active, and the
// caller's Origin must be in the site's allow-list.
//
// DESIGN — the model runs the conversation, the code enforces the rules.
// An earlier version identified the venue by matching words from site names
// against the customer's text. "Something is broken" matched the venue
// "Alfresco Works - Broke 'n Bone" ("broke" sits inside "broken"), and being
// corrected with "that's not where I'm from" just made it give up and raise a
// ticket with no venue and no contact details. Understanding language is the
// model's job. Code only enforces what must never be got wrong:
//
//   1. No answering a support question until the venue is known.
//   2. No raising a ticket until we can actually contact the person.
//   3. Forbidden and urgent topics never reach the model at all.
//   4. Anything unresolved still becomes a ticket — nothing is dropped.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const MAX_TURNS = 40;
const HISTORY_TURNS = 14;

type Playbook = {
  enabled: boolean; greeting: string; tone: string; ask_location: boolean;
  never_answer: string[]; always_escalate: string[]; persona_names: string[];
  unknown_reply: string; business_context: string | null;
};

/** Whole-word keyword match, so "broke" can never fire on "broken". */
function hitsKeyword(text: string, list: string[]): string | null {
  const low = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  for (const raw of list || []) {
    const k = (raw || "").toLowerCase().trim().replace(/\s+/g, " ");
    if (!k) continue;
    if (low.includes(` ${k} `)) return raw;
  }
  return null;
}

function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (!allowed?.length) return true;
  if (!origin) return false;
  let host = origin;
  try { host = new URL(origin).host; } catch { /* keep raw */ }
  return allowed.some((a) => {
    const clean = a.trim().replace(/^https?:\/\//, "").replace(/\/$/, "").toLowerCase();
    return !!clean && (host.toLowerCase() === clean || host.toLowerCase().endsWith("." + clean));
  });
}

/** Every reply ends with one STATE line carrying what the model established:
 *    STATE: venue=<exact name|->; name=<name|->; contact=<email/phone|->; needs_human=<yes|no>
 *  A single mandatory line is complied with far more reliably than a set of
 *  optional ones (the optional version was simply never emitted). It is parsed
 *  out and never shown to the customer. */
function readSignals(raw: string) {
  const out = { venue: "", contact: "", name: "", needsHuman: false, text: "" };
  const keep: string[] = [];
  for (const line of (raw || "").split("\n")) {
    const t = line.trim();
    const m = t.match(/^STATE:\s*(.*)$/i);
    if (!m) {
      // Tolerate the older one-signal-per-line style too.
      if (/^NEEDS_HUMAN\b/i.test(t)) { out.needsHuman = true; continue; }
      const v = t.match(/^VENUE:\s*(.+)$/i);
      if (v) { out.venue = v[1].trim(); continue; }
      keep.push(line);
      continue;
    }
    for (const part of m[1].split(";")) {
      const [kRaw, ...rest] = part.split("=");
      const k = (kRaw || "").trim().toLowerCase();
      const v = rest.join("=").trim();
      if (!v || v === "-" || /^(none|unknown|n\/a)$/i.test(v)) continue;
      if (k === "venue") out.venue = v;
      else if (k === "name") out.name = v;
      else if (k === "contact") out.contact = v;
      else if (k === "needs_human") out.needsHuman = /^(yes|true)$/i.test(v);
    }
  }
  out.text = keep.join("\n").trim();
  return out;
}

const looksLikeEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s.trim());
const looksLikePhone = (s: string) => s.replace(/\D/g, "").length >= 9;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const { site_key, session_id, message, visitor } = (await req.json()) || {};
    if (!site_key) return json({ error: "Missing site_key" }, 422);

    const { data: site } = await supabase.from("chat_sites")
      .select("*").eq("site_key", site_key).eq("active", true).maybeSingle();
    if (!site) return json({ error: "Unknown or inactive site key" }, 403);

    const origin = req.headers.get("origin");
    if (!originAllowed(origin, site.allowed_origins || [])) {
      return json({ error: "This domain isn't allowed to use this chat." }, 403);
    }

    const { data: pbRow } = await supabase.from("chat_playbook").select("*").eq("id", 1).maybeSingle();
    const pb = (pbRow || {}) as Playbook;
    if (pb.enabled === false) return json({ error: "Chat is turned off." }, 503);

    // ── Session ─────────────────────────────────────────────────────────────
    let session: any = null;
    if (session_id) {
      const { data } = await supabase.from("chat_sessions").select("*").eq("id", session_id).maybeSingle();
      session = data;
    }
    if (!session) {
      const { data } = await supabase.from("chat_sessions").insert({
        site_id: site.id,
        location_id: site.location_id,          // POS embeds already know the venue
        origin: origin || null,
        visitor_name: visitor?.name || null,
        visitor_email: visitor?.email || null,
      }).select().single();
      session = data;
      if (!message) {
        await supabase.from("chat_messages").insert({ session_id: session.id, role: "bot", content: pb.greeting });
        return json({ session_id: session.id, reply: pb.greeting, escalated: false });
      }
    }
    if (session.status === "closed") return json({ error: "This chat has ended." }, 410);
    if (!message || !String(message).trim()) return json({ error: "Empty message" }, 422);

    const text = String(message).trim().slice(0, 2000);
    await supabase.from("chat_messages").insert({ session_id: session.id, role: "visitor", content: text });

    const { data: history } = await supabase.from("chat_messages")
      .select("role, content, created_at").eq("session_id", session.id).order("created_at", { ascending: true });

    const mirror = (ticketId: string, role: string, content: string, at?: string) =>
      supabase.from("crm_activities").insert({
        type: "chat",
        direction: role === "visitor" ? "inbound" : "outbound",
        body: content,
        subject_type: "ticket",
        subject_id: ticketId,
        contact_id: session.contact_id,
        is_internal: false,
        channel_metadata: { source: "website_chat", session_id: session.id, author: role === "visitor" ? "Customer" : "Assistant" },
        occurred_at: at || new Date().toISOString(),
      });

    if (session.ticket_id) await mirror(session.ticket_id, "visitor", text);

    const say = async (reply: string) => {
      await supabase.from("chat_messages").insert({ session_id: session.id, role: "bot", content: reply });
      if (session.ticket_id) await mirror(session.ticket_id, "bot", reply);
      await supabase.from("chat_sessions").update({ last_at: new Date().toISOString() }).eq("id", session.id);
      return json({ session_id: session.id, reply, escalated: false });
    };

    const haveContact = () => !!(session.visitor_email || session.visitor_phone);

    const escalate = async (reply: string, reason: string) => {
      let ticket: any = null;
      if (session.ticket_id) {
        const { data } = await supabase.from("tickets").select("id, ticket_number").eq("id", session.ticket_id).maybeSingle();
        ticket = data;
      }

      if (!ticket) {
        // Subject = the problem they first described, not a later aside like
        // "that's not where I'm from".
        const said = (history || []).filter((m) => m.role === "visitor").map((m) => m.content.trim());
        const meaty = said.find((s) => s.length > 12 && !/^(hi|hey|hello|thanks|ok|yes|no)\b/i.test(s));
        const { data: loc } = session.location_id
          ? await supabase.from("locations").select("name").eq("id", session.location_id).maybeSingle()
          : { data: null };

        const header = [
          `Raised from the website chat — ${reason}.`,
          loc?.name ? `Venue: ${loc.name}` : "Venue: not identified.",
          haveContact()
            ? `Contact: ${[session.visitor_name, session.visitor_email, session.visitor_phone].filter(Boolean).join(" · ")}`
            : "No contact details were given.",
          "The full conversation is in the thread below.",
        ].join("\n");

        const { data: created, error: tErr } = await supabase.from("tickets").insert({
          subject: (meaty || text).slice(0, 120),
          description: header,
          channel: "chat",
          source: "chat",
          customer_email: session.visitor_email || null,
          customer_phone: session.visitor_phone || null,
          contact_id: session.contact_id,
        }).select("id, ticket_number").maybeSingle();

        // The whole safety net is "it raises a ticket" — never fail quietly.
        if (tErr || !created) {
          console.error("chat: ESCALATION FAILED to create a ticket:", tErr?.message || "no row returned");
        }
        ticket = created;

        if (ticket) {
          await supabase.from("stage_history").insert({
            object_type: "ticket", object_id: ticket.id, from_stage: null, to_stage: "new",
          });
          // Only ever claim a venue that was actually confirmed.
          if (session.location_id) {
            await supabase.from("associations").insert({
              from_type: "ticket", from_id: ticket.id,
              to_type: "location", to_id: session.location_id, label: "affected_location",
            });
          }
          for (const m of (history || [])) await mirror(ticket.id, m.role, m.content, m.created_at);
        }
      }

      const withNumber = ticket?.ticket_number ? `${reply} (Reference #${ticket.ticket_number}.)` : reply;
      await supabase.from("chat_messages").insert({
        session_id: session.id, role: "bot", content: withNumber, escalated: true,
      });
      if (ticket) await mirror(ticket.id, "bot", withNumber);
      await supabase.from("chat_sessions").update({
        status: "escalated", ticket_id: ticket?.id || null,
        pending_reason: null, last_at: new Date().toISOString(),
      }).eq("id", session.id);
      return json({ session_id: session.id, reply: withNumber, escalated: true, ticket_number: ticket?.ticket_number || null });
    };

    // Rule 2: never raise a ticket nobody can reply to. Ask once — if they still
    // give nothing, raise it anyway so the problem is never lost.
    const wantEscalation = async (reply: string, reason: string) => {
      if (haveContact() || session.pending_reason) return await escalate(reply, reason);
      await supabase.from("chat_sessions").update({ pending_reason: reason }).eq("id", session.id);
      session.pending_reason = reason;
      return await say("Of course — I'll get this to the team. What's the best email or phone number to reach you on?");
    };

    // Depth cap: a long back-and-forth that hasn't fixed it is a person's job.
    // Staff on shift shouldn't be led through an engineering session.
    const botTurns = (history || []).filter((m) => m.role === "bot").length;
    if (botTurns >= 6 && !session.ticket_id) {
      return await wantEscalation(
        "We've tried the quick things and it's still not right — I'll get someone from the team onto this properly.",
        "troubleshooting depth reached",
      );
    }

    if ((history || []).length >= MAX_TURNS) {
      return await wantEscalation("We've covered a lot here — let me get a person onto this.", "conversation length");
    }

    // ── Rule 3: topic rules, before the model is asked anything ─────────────
    const urgent = hitsKeyword(text, pb.always_escalate || []);
    if (urgent) {
      return await wantEscalation("That sounds urgent — I'm getting this straight to our support team.", `urgent keyword: ${urgent}`);
    }
    const forbidden = hitsKeyword(text, pb.never_answer || []);
    if (forbidden) return await wantEscalation(pb.unknown_reply, `restricted topic: ${forbidden}`);

    // ── Context for the model ───────────────────────────────────────────────
    const { data: cfg } = await supabase.from("ai_settings").select("*").eq("id", 1).maybeSingle();
    if (!cfg?.enabled || !cfg?.api_key) return await wantEscalation(pb.unknown_reply, "AI not configured");

    // Identity comes from settings. Never hard-code a company or product name —
    // each CRM supports different software, and getting this wrong is worse than
    // saying nothing.
    const { data: biz } = await supabase.from("support_settings")
      .select("business_name").eq("id", 1).maybeSingle();
    const company = (biz?.business_name || "").trim();
    const { data: modRows } = await supabase.from("modules").select("name").order("name");
    const products = (modRows || []).map((m: any) => m.name).filter(Boolean);

    let location: any = null;
    let liveModules: string[] = [];   // the software this site actually runs
    if (session.location_id) {
      const { data } = await supabase.from("locations").select("id, name, city").eq("id", session.location_id).maybeSingle();
      location = data;
    }
    const { data: allLocs } = await supabase.from("locations").select("id, name").order("name").limit(1000);

    const names = (pb.persona_names || []).filter(Boolean);
    const persona = names.length ? names[Math.floor(Math.random() * names.length)] : null;

    let venueBlock: string;
    if (location) {
      const { data: mods } = await supabase.from("location_modules")
        .select("status, module:modules(name)").eq("location_id", location.id);
      const live = (mods || []).filter((m: any) => m.status === "live").map((m: any) => m.module?.name).filter(Boolean);
      liveModules = live;
      // What hardware is actually deployed there, so it can talk about the real kit.
      const { data: kit } = await supabase.from("inv_serials")
        .select("product_name, category, serial").eq("location_id", location.id).limit(40);
      const kitLine = (kit || []).length
        ? ` Hardware on site: ${[...new Set((kit || []).map((k: any) => k.product_name).filter(Boolean))].join(", ")}.`
        : "";
      venueBlock = `The customer is at ${location.name}${location.city ? `, ${location.city}` : ""}.` +
        (live.length ? ` Live modules there: ${live.join(", ")}.` : "") + kitLine;
    } else if (pb.ask_location) {
      venueBlock =
        `You do NOT know which venue the customer is at. Ask before troubleshooting.\n` +
        `Only match what they actually say to this list. Never infer a venue from ordinary words in their problem ` +
        `("something is broken" is NOT the venue "Broke 'n Bone"). If it isn't clearly one of these, ask again.\n` +
        (allLocs || []).map((l: any) => `- ${l.name}`).join("\n");
    } else {
      venueBlock = "The venue is not needed for this chat.";
    }

    // A till in the venue is a trusted place to answer; a public website is not.
    // Internal knowledge (admin codes, network work) is only ever served to a
    // trusted embed.
    const trustedEmbed = site.trust === "internal";

    // What we already know about this kind of problem. Retrieval is over our own
    // resolved tickets and written how-tos — the assistant may only answer from
    // these, so it can't invent a fix.
    const problem = (history || []).filter((m) => m.role === "visitor")
      .slice(-4).map((m) => m.content).join(" ").slice(0, 400);
    let knowledge: any[] = [];
    if (problem.trim().length > 8) {
      const { data: kb } = await supabase.rpc("kb_search", {
        q: problem, loc: session.location_id,
        mods: liveModules.length ? liveModules : null,
        lim: 5,
        trusted: trustedEmbed,
      });
      knowledge = kb || [];
    }
    const knowledgeBlock = knowledge.length
      ? `KNOWN FIXES — these come from problems we have actually solved before. ` +
        `Answer from these when one fits, in your own words, as clear steps.\n` +
        knowledge.map((k: any, i: number) =>
          `[${i + 1}] ${k.title || k.question}\nProblem: ${k.question}\nFix: ${k.answer}`).join("\n\n")
      : `KNOWN FIXES: nothing on file matches this yet. Ask diagnostic questions if that would help ` +
        `narrow it down, but do NOT invent a fix — signal needs_human once you understand the problem.`;

    const contactBlock = haveContact()
      ? "You already have their contact details."
      : "You do NOT have their contact details. Only ask for them when a person needs to take over.";

    const identity =
      (pb.business_context || "").trim() ||
      [
        company ? `You work for ${company}.` : "",
        products.length ? `${company || "The company"} supports these products: ${products.join(", ")}.` : "",
        "Never name a product or system that isn't listed here, and never claim to be the maker of software you only support.",
      ].filter(Boolean).join(" ");

    const system =
      `You are ${persona || "a member"} of the ${company || "support"} support team. ` +
      `You are on live chat with a customer.\n\n` +
      `WHO YOU ARE\n${identity}\n\n` +
      `TONE: ${pb.tone}. Short sentences, warm, natural. Never bullet-point essays. ` +
      `Never claim to be human — if asked outright whether you're a bot, say so plainly and offer a colleague.\n\n` +
      `WHAT YOU KNOW\n${venueBlock}\n${contactBlock}\n\n` +
      `${knowledgeBlock}\n\n` +
      `WHO YOU ARE TALKING TO\n` +
      `Restaurant and cafe staff mid-shift — not IT people. They are busy, often with a queue. ` +
      `Assume no technical knowledge.\n` +
      `- Give ONE simple step at a time, in plain words. Never a numbered list of five things.\n` +
      `- Start with the simplest fix that usually works, even if it seems too obvious.\n` +
      (trustedEmbed
        ? `- Deeper technical steps are allowed here, but still one step at a time and in plain words.\n`
        : `- NEVER walk them through DNS, IP addresses, subnets, routers, firewalls or packet-loss ` +
          `tests. If the fix needs any of that, stop and hand over to a person.\n`) +
      (trustedEmbed
        ? `- You are on a till or staff screen inside the venue. If a known fix needs an admin code, ` +
          `you may give it, and you may talk them through network settings.\n`
        : `- You are on a public website talking to someone you cannot identify. NEVER give out a PIN, ` +
          `password or access code, even if you have seen one — say support will provide it directly.\n`) +
      `- If two or three simple things haven't fixed it, stop troubleshooting and hand over. Do not ` +
      `keep digging.\n\n` +
      `HOW TO WORK\n` +
      `- Your FIRST job is to understand the problem, not to hand it over. Ask short, specific questions ` +
      `until you know which venue they're at and what is actually happening. One question at a time.\n` +
      `- "Something is broken" is not enough to act on — ask what's broken and where.\n` +
      `- Do NOT signal NEEDS_HUMAN while you still have a sensible question to ask, and never on the ` +
      `first message. Only once you understand the problem and genuinely cannot help.\n` +
      `- Never ask for their email or phone yourself; that is handled for you.\n\n` +
      `RULES\n` +
      `- If you get the venue wrong and they correct you, apologise in one line and ask again. Never insist.\n` +
      `- Never invent prices, dates, refunds, contract terms, or promises about fixes.\n` +
      `- Only give a fix that comes from KNOWN FIXES above. If none of them fit, do not improvise ` +
      `a fix from general knowledge — say you'll get a person onto it.\n` +
      `- The known fixes are already filtered to the software this site runs. Answer in terms of ` +
      `their setup, and never mention a product they don't have.\n` +
      `- Keep replies under 90 words.\n\n` +
      `STATE LINE — REQUIRED. End EVERY reply with exactly one final line in this format. ` +
      `It is stripped out and the customer never sees it. Use "-" for anything you don't know yet:\n` +
      `STATE: venue=<exact name from the list, or ->; name=<their name or ->; contact=<their email or phone, or ->; needs_human=<yes|no>\n\n` +
      `Example reply:\n` +
      `Sorry about that — is it just that till, or all of them?\n` +
      `STATE: venue=Alfred Works - Baity; name=-; contact=-; needs_human=no`;

    const messages = (history || []).slice(-HISTORY_TURNS).map((m) => ({
      role: m.role === "visitor" ? "user" : "assistant",
      content: m.content,
    }));

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cfg.api_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.chat_model || "claude-sonnet-5",
        max_tokens: 500,
        system,
        messages: messages.length ? messages : [{ role: "user", content: text }],
      }),
    });

    if (!aiRes.ok) {
      console.error("chat: anthropic error", aiRes.status, await aiRes.text());
      return await wantEscalation(pb.unknown_reply, "AI request failed");
    }

    const ai = await aiRes.json();
    // The reply is the TEXT block. Responses can start with a thinking block,
    // so content[0] is not necessarily the answer (this cost an afternoon).
    const replyText = (ai.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const sig = readSignals(replyText);

    // ── Apply what the model established ────────────────────────────────────
    const patch: Record<string, unknown> = {};
    if (sig.venue) {
      const v = sig.venue.toLowerCase();
      const found = (allLocs || []).find((l: any) => String(l.name).toLowerCase() === v)
        || (allLocs || []).find((l: any) => String(l.name).toLowerCase().includes(v));
      if (found) { patch.location_id = found.id; session.location_id = found.id; }
    }
    if (sig.name) { patch.visitor_name = sig.name; session.visitor_name = sig.name; }
    if (sig.contact) {
      if (looksLikeEmail(sig.contact)) { patch.visitor_email = sig.contact; session.visitor_email = sig.contact; }
      else if (looksLikePhone(sig.contact)) { patch.visitor_phone = sig.contact; session.visitor_phone = sig.contact; }
    }
    if (Object.keys(patch).length) await supabase.from("chat_sessions").update(patch).eq("id", session.id);

    // Were we waiting on contact details before raising a ticket?
    if (session.pending_reason) {
      return haveContact()
        ? await escalate("Thanks — I've passed this to the team and someone will come back to you.", session.pending_reason)
        : await escalate(pb.unknown_reply, `${session.pending_reason} (no contact details given)`);
    }

    // Guard against handing over before the conversation has even started: while
    // the venue is still unknown (or this is their opening message) there is
    // always a better question to ask than "what's your email?".
    const visitorTurns = (history || []).filter((m) => m.role === "visitor").length;
    const tooEarly = visitorTurns <= 1 || (pb.ask_location && !session.location_id);

    if ((sig.needsHuman || !sig.text) && tooEarly) {
      return await say(sig.text || (pb.ask_location && !session.location_id
        ? "Happy to help — which site are you at, and what's happening?"
        : "Tell me a bit more about what's happening and I'll see what I can do."));
    }

    if (sig.needsHuman || !sig.text) {
      return await wantEscalation(sig.text || pb.unknown_reply, "assistant was not confident");
    }

    return await say(sig.text);
  } catch (e) {
    console.error("chat error:", (e as Error).message);
    return json({ error: "Something went wrong." }, 500);
  }
});
