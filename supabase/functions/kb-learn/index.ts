// kb-learn — teach the assistant from supplier documentation or your own notes.
//
// Two ways in:
//   POST { url, module }   — fetch a supplier doc page and split it into answers
//   POST { text, module }  — paste anything (a doc, an email, a runbook)
//
// Both are distilled by Claude into discrete question/answer entries tagged
// with the module they belong to, so a venue on LS-Pay is never given a Zettle
// fix. Nothing is invented: the model is told to use only what's on the page.
//
// Staff only (editor/owner).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/** Crude but dependency-free HTML → text. Drops nav/script/style so the model
 *  sees the documentation, not the chrome around it. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser(auth);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!["owner", "editor"].includes(me?.role || "")) return json({ error: "Editors and owners only" }, 403);

  try {
    const { url, text: pasted, module, location_id, dry_run = false } = (await req.json()) || {};
    if (!url && !pasted) return json({ error: "Give me a documentation URL or paste the text." }, 422);

    const { data: cfg } = await supabase.from("ai_settings").select("*").eq("id", 1).maybeSingle();
    if (!cfg?.api_key) return json({ error: "Add your Anthropic API key in Settings → AI Assistant first." }, 400);

    // Only accept modules that actually exist, so knowledge can be matched to
    // what a site runs.
    const { data: modRows } = await supabase.from("modules").select("name").order("name");
    const products = (modRows || []).map((m: any) => m.name).filter(Boolean);
    if (module && !products.includes(module)) {
      return json({ error: `"${module}" isn't one of your modules.`, modules: products }, 422);
    }

    let source_text = String(pasted || "");
    let title_hint = "";

    if (url) {
      let u: URL;
      try { u = new URL(url); } catch { return json({ error: "That doesn't look like a URL." }, 422); }
      if (!["http:", "https:"].includes(u.protocol)) return json({ error: "Only http(s) URLs." }, 422);

      const r = await fetch(u.toString(), {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; SupportKB/1.0)", "Accept": "text/html,text/plain" },
        redirect: "follow",
      });
      if (!r.ok) return json({ error: `Couldn't read that page (HTTP ${r.status}).` }, 400);
      const ct = r.headers.get("content-type") || "";
      const body = await r.text();
      source_text = ct.includes("html") ? htmlToText(body) : body;
      title_hint = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
    }

    source_text = source_text.slice(0, 40000);
    if (source_text.length < 200) return json({ error: "There wasn't enough readable content there." }, 422);

    const system =
      `You convert product documentation into support answers for a helpdesk.\n\n` +
      `Return strict JSON: {"entries":[{"title":"...","question":"...","answer":"...","category":"..."}]}\n\n` +
      `- Produce one entry per distinct problem or task the document covers. Up to 12. Fewer is fine.\n` +
      `- question: how a customer would describe needing this, in plain words.\n` +
      `- answer: the steps, written to the customer. Numbered if multi-step. No marketing, no links unless essential.\n` +
      `- category: one of Menu, Printers, Payments, Hardware, Orders, Loyalty, Stock, Users, Reports, Account, Other.\n` +
      `- Use ONLY what the document says. Never add steps from your own knowledge. If the document is ` +
      `marketing fluff or contains no actionable instructions, return {"entries":[]}.\n` +
      `- NEVER include a PIN, password, passcode or access code in the answer. Write "[ask support]" instead.\n` +
        `- Set "internal_only":true when the fix needs an engineer, an admin password, or network work ` +
        `(DNS, IP addresses, routers, firewalls) — that is not something cafe staff can do.\n` +
        `- Set "first_line":true when this is the simple thing to try FIRST for that symptom.\n` +
        `Return JSON only.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": cfg.api_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: cfg.chat_model || "claude-sonnet-5",
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: `${module ? `Product: ${module}\n` : ""}${title_hint ? `Page: ${title_hint}\n` : ""}\n${source_text}` }],
      }),
    });
    if (!r.ok) return json({ error: `The AI request failed (${r.status}).` }, 502);

    const ai = await r.json();
    const raw = (ai.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: "Couldn't make sense of that document." }, 422);

    const parsed = JSON.parse(m[0]);
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    if (!entries.length) return json({ ok: true, learned: 0, note: "Nothing worth keeping on that page." });

    if (dry_run) return json({ ok: true, learned: 0, preview: entries.slice(0, 5) });

    const rows = entries
      .filter((e: any) => e.question && e.answer)
      .map((e: any) => ({
        source: url ? "doc" : "manual",
        source_ref: url || null,
        title: (e.title || "").slice(0, 160),
        question: e.question,
        answer: e.answer,
        category: e.category || null,
        module: module || null,
        internal_only: !!e.internal_only,
        first_line: !!e.first_line,
        location_id: location_id || null,
        created_by: user.id,
      }));

    const { error } = await supabase.from("kb_docs").insert(rows);
    if (error) return json({ error: error.message }, 500);

    return json({ ok: true, learned: rows.length, samples: rows.slice(0, 4).map((r: any) => r.title) });
  } catch (e) {
    console.error("kb-learn error:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
