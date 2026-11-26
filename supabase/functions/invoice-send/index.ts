// Sends an invoice to the customer by email (from the connected support
// mailbox) and marks it sent. Auth: caller JWT, editor/owner only.

import { invoiceSeller } from "../_shared/region.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { invoiceEmailHtml, sendInvoiceEmail } from "../_shared/invoiceEmail.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

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
    const { invoice_id, to } = await req.json();
    if (!invoice_id) return json({ error: "Missing invoice_id" }, 422);

    const { data: inv } = await supabase.from("invoices").select("*").eq("id", invoice_id).maybeSingle();
    if (!inv) return json({ error: "Invoice not found" }, 404);
    if (inv.status === "void") return json({ error: "Invoice is void" }, 400);

    // Resolve recipient: explicit > stored > linked contact's email
    let recipient = (to || inv.email_to || "").trim();
    if (!recipient && inv.contact_id) {
      const { data: c } = await supabase.from("contacts").select("email").eq("id", inv.contact_id).maybeSingle();
      recipient = c?.email || "";
    }
    if (!recipient) return json({ error: "No recipient email — add one to the invoice or link a contact." }, 422);

    const { data: seller } = await invoiceSeller(supabase, inv.currency);

    const appUrl = Deno.env.get("APP_URL") || "https://posupject.vercel.app";
    const link = `${appUrl}/i/${inv.public_token}`;
    const { subject, html } = invoiceEmailHtml(inv, seller || {}, link);
    await sendInvoiceEmail(supabase, recipient, subject, html);

    await supabase.from("invoices").update({
      status: inv.status === "paid" ? "paid" : "sent",
      sent_at: new Date().toISOString(),
      email_to: recipient,
    }).eq("id", inv.id);

    return json({ success: true, to: recipient });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
