// Emails a credit note to the customer (from the connected support mailbox)
// and stamps when and to whom it went. Auth: caller JWT, editor/owner only.
//
// credit_notes has no update policy (every change goes through the credit note
// database functions), so sent_at and email_to are stamped with the service
// role client this function already holds.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { creditNoteEmailHtml, sendInvoiceEmail } from "../_shared/invoiceEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// One plain address. The recipient goes straight into the To header, so a
// line break or a second address must never get through.
const looksLikeEmail = (s: string) => /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(s);

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!auth) return json({ error: "Unauthorized" }, 401);
  const { data: { user } } = await supabase.auth.getUser(auth);
  if (!user) return json({ error: "Unauthorized" }, 401);
  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!me || !["owner", "editor"].includes(me.role)) return json({ error: "Forbidden" }, 403);

  try {
    const { credit_note_id, to } = await req.json();
    if (!credit_note_id) return json({ error: "Missing credit_note_id" }, 422);

    const { data: note } = await supabase.from("credit_notes").select("*").eq("id", credit_note_id).maybeSingle();
    if (!note) return json({ error: "Credit note not found." }, 404);
    // A cancelled credit note is kept for the record, but it no longer
    // reduces the invoice, so it must never reach the customer as if it did.
    if (note.status === "cancelled") return json({ error: "This credit note is cancelled, so it cannot be sent." }, 400);

    const { data: inv } = await supabase.from("invoices").select("*").eq("id", note.invoice_id).maybeSingle();
    if (!inv) return json({ error: "Invoice not found." }, 404);

    // Resolve recipient: explicit > stored on the note > the invoice's > linked contact's email
    let recipient = String(to || note.email_to || inv.email_to || "").trim();
    const contactId = note.contact_id || inv.contact_id;
    if (!recipient && contactId) {
      const { data: c } = await supabase.from("contacts").select("email").eq("id", contactId).maybeSingle();
      recipient = String(c?.email || "").trim();
    }
    if (!recipient) return json({ error: "No email address to send to. Add one, or link a contact to the invoice." }, 422);
    if (!looksLikeEmail(recipient)) return json({ error: "That email address does not look right." }, 422);

    const { data: seller } = await supabase.from("support_settings")
      .select("business_name, business_email, business_phone, quote_accent, logo_url").eq("id", 1).maybeSingle();

    const appUrl = Deno.env.get("APP_URL") || "https://posupject.vercel.app";
    const link = `${appUrl}/c/${note.public_token}`;
    const { subject, html } = creditNoteEmailHtml(note, inv, seller || {}, link);
    await sendInvoiceEmail(supabase, recipient, subject, html);

    // The email has gone either way. A failed stamp only loses the "sent"
    // marker, so it is logged and reported rather than turned into an error
    // that would tempt someone to send it again.
    const sentAt = new Date().toISOString();
    const { error: stampErr } = await supabase.from("credit_notes")
      .update({ sent_at: sentAt, email_to: recipient }).eq("id", note.id);
    if (stampErr) console.error(`credit-note-send: sent CN-${note.credit_number} but could not stamp it:`, stampErr.message);

    return json({ success: true, to: recipient, sent_at: stampErr ? null : sentAt });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
