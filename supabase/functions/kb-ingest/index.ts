// kb-ingest — turn resolved tickets into reusable support knowledge.
//
// Raw threads are not usable as knowledge: they carry signatures, quoted
// history, pleasantries and half-finished trains of thought. So each resolved
// ticket is distilled by Claude into one clean question/answer pair, which is
// what the assistant later retrieves.
//
// Only tickets that actually got an answer are considered, and each ticket is
// ingested once (tracked by source_ref).
//
// POST { limit?: number, dry_run?: boolean }  — staff only (editor/owner).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** Strip signatures, quoted replies and disclaimers so only the real message
 *  is fed to the model. */
function clean(body: string): string {
  let t = (body || "").replace(/\r/g, "");
  const cuts = [
    /^\s*On .+ wrote:\s*$/m,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/mi,
    /^\s*From:\s.+$/m,
    /^\s*--\s*$/m,
    /^\s*Sent from my /mi,
  ];
  for (const re of cuts) {
    const m = t.match(re);
    if (m?.index !== undefined) t = t.slice(0, m.index);
  }
  return t.split("\n").filter((l) => !l.trim().startsWith(">")).join("\n").trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Staff only.
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser(auth);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!["owner", "editor"].includes(me?.role || "")) return json({ error: "Editors and owners only" }, 403);

  try {
    const { limit = 25, dry_run = false } = (await req.json().catch(() => ({}))) || {};

    const { data: cfg } = await supabase.from("ai_settings").select("*").eq("id", 1).maybeSingle();
    if (!cfg?.api_key) return json({ error: "Add your Anthropic API key in Settings → AI Assistant first." }, 400);

    const { data: biz } = await supabase.from("support_settings").select("business_name").eq("id", 1).maybeSingle();
    const company = (biz?.business_name || "").trim();
    const { data: modRows } = await supabase.from("modules").select("name").order("name");
    const products = (modRows || []).map((m: any) => m.name).filter(Boolean);

    // Which tickets have we already learned from?
    const { data: done } = await supabase.from("kb_docs").select("source_ref").eq("source", "ticket");
    const seen = new Set((done || []).map((d: any) => d.source_ref).filter(Boolean));

    const { data: tickets } = await supabase.from("tickets")
      .select("id, subject, ticket_type, stage, company_id")
      .in("stage", ["resolved", "closed"])
      .order("created_at", { ascending: false })
      .limit(400);

    const todo = (tickets || []).filter((t: any) => !seen.has(t.id)).slice(0, Math.min(limit, 50));
    const result = { considered: todo.length, learned: 0, skipped_no_answer: 0, skipped_thin: 0, errors: 0, samples: [] as any[] };

    for (const t of todo) {
      const { data: acts } = await supabase.from("crm_activities")
        .select("direction, subject, body, occurred_at")
        .eq("subject_type", "ticket").eq("subject_id", t.id)
        .order("occurred_at", { ascending: true }).limit(40);

      const inbound = (acts || []).filter((a: any) => a.direction === "inbound").map((a: any) => clean(a.body || "")).filter(Boolean);
      const outbound = (acts || []).filter((a: any) => a.direction === "outbound").map((a: any) => clean(a.body || "")).filter(Boolean);

      // No reply = nothing was learned here.
      if (!outbound.length) { result.skipped_no_answer++; continue; }
      const transcript = (acts || [])
        .map((a: any) => `${a.direction === "inbound" ? "Customer" : "Support"}: ${clean(a.body || "")}`)
        .filter((l: string) => l.length > 12).join("\n\n").slice(0, 12000);
      if (transcript.length < 120) { result.skipped_thin++; continue; }

      const system =
        `You turn resolved support conversations into reusable knowledge for ${company || "a support team"}.` +
        (products.length ? ` They support: ${products.join(", ")}.` : "") + `\n\n` +
        `Read the conversation and produce ONE reusable entry, as strict JSON:\n` +
        `{"useful":true|false,"title":"...","question":"...","answer":"...","category":"...","module":"..."}\n\n` +
        `- useful=false if nothing generalisable was learned (chit-chat, a one-off admin request, ` +
        `no actual resolution, or the fix was purely internal).\n` +
        `- question: the problem in the customer's words, generalised (no names, venues, order numbers).\n` +
        `- answer: the steps that resolved it, written as clear instructions to a customer. ` +
        `Numbered steps if there is more than one. No greetings, no sign-off, no apologies.\n` +
        `- category: one of Menu, Printers, Payments, Hardware, Orders, Loyalty, Stock, Users, Reports, Account, Other.\n` +
        `- module: the product involved if obvious, else "".\n` +
        `- Never invent a fix that isn't in the conversation.\n` +
        `- NEVER include a PIN, password, passcode or access code in the answer. Write "[ask support]" instead.\n` +
        `- Set "internal_only":true when the fix needs an engineer, an admin password, or network work ` +
        `(DNS, IP addresses, routers, firewalls) — that is not something cafe staff can do.\n` +
        `- Set "first_line":true when this is the simple thing to try FIRST for that symptom.\n` +
        `Return JSON only.`;

      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": cfg.api_key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: cfg.chat_model || "claude-sonnet-5",
            max_tokens: 900,
            system,
            messages: [{ role: "user", content: `Ticket subject: ${t.subject || "(none)"}\n\n${transcript}` }],
          }),
        });
        if (!r.ok) { result.errors++; continue; }
        const ai = await r.json();
        // The answer is the text block — a response can open with a thinking block.
        const raw = (ai.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) { result.errors++; continue; }
        const doc = JSON.parse(m[0]);

        if (!doc.useful || !doc.question || !doc.answer) { result.skipped_thin++; continue; }

        if (!dry_run) {
          await supabase.from("kb_docs").insert({
            source: "ticket", source_ref: t.id,
            title: (doc.title || t.subject || "").slice(0, 160),
            question: doc.question, answer: doc.answer,
            category: doc.category || null, module: doc.module || null,
            internal_only: !!doc.internal_only, first_line: !!doc.first_line,
            created_by: user.id,
          });
        }
        result.learned++;
        if (result.samples.length < 3) result.samples.push({ title: doc.title, category: doc.category });
      } catch (_) {
        result.errors++;
      }
    }

    return json({ ok: true, ...result });
  } catch (e) {
    console.error("kb-ingest error:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
