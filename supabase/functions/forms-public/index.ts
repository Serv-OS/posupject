// Public forms endpoint (no auth).
//   GET  ?slug=...   -> returns the form definition for rendering
//   POST { slug, data, page_url, referrer, src } -> processes a submission
//        into a Lead or a Support ticket, with source tracking.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // ---- GET: return the public form definition ----
    if (req.method === "GET") {
      const url = new URL(req.url);
      const slug = url.searchParams.get("slug");
      if (!slug) return json({ error: "Missing slug" }, 400);

      const { data: form } = await supabase
        .from("forms")
        .select("name, description, destination, source_tag, fields, settings, enabled")
        .eq("slug", slug)
        .maybeSingle();

      if (!form) return json({ error: "Form not found" }, 404);
      if (!form.enabled) return json({ error: "This form is no longer active." }, 410);
      const { data: s } = await supabase.from("support_settings").select("logo_url, business_name, recaptcha_site_key").eq("id", 1).maybeSingle();
      return json({ form, branding: { logo_url: s?.logo_url || null, business_name: s?.business_name || null, recaptcha_site_key: s?.recaptcha_site_key || null } });
    }

    // ---- POST: process a submission ----
    if (req.method === "POST") {
      const body = await req.json();
      const { slug, data = {}, page_url = null, referrer = null, src = null } = body;
      if (!slug) return json({ error: "Missing slug" }, 400);

      const { data: form } = await supabase
        .from("forms")
        .select("*")
        .eq("slug", slug)
        .maybeSingle();
      if (!form) return json({ error: "Form not found" }, 404);
      if (!form.enabled) return json({ error: "This form is no longer active." }, 410);

      // Spam protection — verify the reCAPTCHA v2 token when a secret is set.
      const rcSecret = Deno.env.get("RECAPTCHA_SECRET_KEY");
      if (rcSecret) {
        const rres = await fetch("https://www.google.com/recaptcha/api/siteverify", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: rcSecret, response: String(body.recaptcha_token || "") }),
        });
        const rjson = await rres.json().catch(() => ({}));
        if (!rjson.success) return json({ error: "reCAPTCHA check failed — please try again." }, 400);
      }

      // Validate required fields
      for (const f of form.fields || []) {
        if (f.required && !String(data[f.key] ?? "").trim()) {
          return json({ error: `Please fill in "${f.label}".` }, 422);
        }
      }

      // Map submitted values to known CRM fields via each field's maps_to.
      const mapped: Record<string, string> = {};
      const extras: string[] = [];
      for (const f of form.fields || []) {
        const val = String(data[f.key] ?? "").trim();
        if (!val) continue;
        if (f.maps_to && f.maps_to !== "none") {
          mapped[f.maps_to] = val;
        } else {
          extras.push(`${f.label}: ${val}`);
        }
      }

      const sourceTag = (src || form.source_tag || (form.destination === "support" ? "web_form" : "website")) as string;
      const extrasNote = extras.length ? `\n\n--- Form details ---\n${extras.join("\n")}` : "";
      const pageNote = page_url ? `\n(Submitted from: ${page_url})` : "";

      const submission: Record<string, unknown> = {
        form_id: form.id, data, source_tag: sourceTag, page_url, referrer, status: "processed",
      };

      // Resolve / create contact
      let contactId: string | null = null;
      const email = mapped.email || null;
      const phone = mapped.phone || null;
      if (email || phone) {
        let q = supabase.from("contacts").select("id").limit(1);
        if (email) q = q.ilike("email", email);
        else q = q.eq("phone", phone);
        const { data: existing } = await q;
        if (existing && existing.length) {
          contactId = existing[0].id;
        } else {
          const { data: c } = await supabase.from("contacts").insert({
            first_name: mapped.first_name || null,
            last_name: mapped.last_name || null,
            email, phone,
            job_title: mapped.job_title || null,
            source: sourceTag,
          }).select("id").single();
          contactId = c?.id || null;
        }
      }

      // Resolve / create company (by name)
      let companyId: string | null = null;
      if (mapped.company_name) {
        const { data: existing } = await supabase.from("companies").select("id").ilike("name", mapped.company_name).limit(1);
        if (existing && existing.length) companyId = existing[0].id;
        else {
          const { data: co } = await supabase.from("companies").insert({
            name: mapped.company_name,
            domain: mapped.company_domain || null,
            city: mapped.company_city || null,
          }).select("id").single();
          companyId = co?.id || null;
        }
        if (companyId && contactId) {
          await supabase.from("associations").insert({
            from_type: "contact", from_id: contactId, to_type: "company", to_id: companyId, label: "primary_contact",
          });
        }
      }

      // Resolve / create location (under the company)
      let locationId: string | null = null;
      if (mapped.location_name && companyId) {
        const { data: existingLoc } = await supabase.from("locations")
          .select("id").eq("company_id", companyId).ilike("name", mapped.location_name).limit(1);
        if (existingLoc && existingLoc.length) locationId = existingLoc[0].id;
        else {
          const { data: loc } = await supabase.from("locations").insert({
            name: mapped.location_name, company_id: companyId,
            address: mapped.location_address || null,
            city: mapped.location_city || null,
            postcode: mapped.location_postcode || null,
            status: "prospect",
          }).select("id").single();
          locationId = loc?.id || null;
        }
        if (locationId && contactId) {
          await supabase.from("associations").insert({
            from_type: "contact", from_id: contactId, to_type: "location", to_id: locationId, label: "primary_contact",
          });
        }
      }

      const personName = [mapped.first_name, mapped.last_name].filter(Boolean).join(" ");

      if (form.destination === "support") {
        // Create a support ticket (auto-assign trigger will route it)
        const ticketData: Record<string, unknown> = {
          subject: mapped.subject || `${form.name} submission${personName ? ` from ${personName}` : ""}`,
          description: (mapped.message || "") + extrasNote + pageNote,
          channel: "web",
          source: sourceTag,
          customer_email: email,
          customer_phone: phone,
          contact_id: contactId,
          priority: form.settings?.default_priority || "P2",
        };
        if (companyId) ticketData.company_id = companyId;

        const { data: ticket, error: tErr } = await supabase.from("tickets").insert(ticketData).select("id").single();
        if (tErr) {
          submission.status = "error"; submission.error = tErr.message;
          await supabase.from("form_submissions").insert(submission);
          return json({ error: "Could not create ticket" }, 500);
        }
        await supabase.from("stage_history").insert({ object_type: "ticket", object_id: ticket.id, from_stage: null, to_stage: "new" });
        if (contactId) {
          await supabase.from("associations").insert({
            from_type: "ticket", from_id: ticket.id, to_type: "contact", to_id: contactId, label: "primary_contact",
          });
        }
        if (locationId) {
          await supabase.from("associations").insert({
            from_type: "ticket", from_id: ticket.id, to_type: "location", to_id: locationId, label: "affected_location",
          });
        }
        submission.created_ticket_id = ticket.id;
        submission.created_contact_id = contactId;
        submission.created_company_id = companyId;
        await supabase.from("form_submissions").insert(submission);
      } else {
        // Create a lead
        const leadName = mapped.company_name || personName || email || form.name;
        const { data: lead, error: lErr } = await supabase.from("leads").insert({
          name: leadName,
          stage: "new_lead",
          source: sourceTag,
          company_id: companyId,
          contact_id: contactId,
          location_id: locationId,
          venue_type: mapped.venue_type || null,
          covers: mapped.covers ? parseInt(mapped.covers) : null,
          current_pos: mapped.current_pos || null,
          priority: form.settings?.default_priority || "warm",
          notes: (mapped.message || "") + extrasNote + pageNote,
        }).select("id").single();
        if (lErr) {
          submission.status = "error"; submission.error = lErr.message;
          await supabase.from("form_submissions").insert(submission);
          return json({ error: "Could not create lead" }, 500);
        }
        await supabase.from("stage_history").insert({ object_type: "lead", object_id: lead.id, from_stage: null, to_stage: "new_lead" });
        submission.created_lead_id = lead.id;
        submission.created_contact_id = contactId;
        submission.created_company_id = companyId;
        await supabase.from("form_submissions").insert(submission);
      }

      return json({
        success: true,
        message: form.settings?.success_message || "Thanks — we'll be in touch shortly.",
        redirect_url: form.settings?.redirect_url || null,
      });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
