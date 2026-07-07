// Shared helper: send a branded invoice email from the connected support
// mailbox (gmail_connections). Used by invoice-send and invoice-recurring.
import { encodeMimeWord } from "./mime.ts";

export async function getGmailAccessToken(supabase: any): Promise<string> {
  const clientId = Deno.env.get("GMAIL_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GMAIL_CLIENT_SECRET")!;
  const { data: conn } = await supabase
    .from("gmail_connections").select("refresh_token")
    .eq("is_active", true).order("updated_at", { ascending: false }).limit(1).single();
  const refreshToken = conn?.refresh_token;
  if (!refreshToken) throw new Error("No support mailbox connected. Connect one in Settings.");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: refreshToken, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get Gmail access token");
  return data.access_token;
}

const gbp = (n: number) => "£" + (Number(n) || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Currency formatter reused by the PDF builder so the email + attachment agree.
export const money = gbp;
const fmtDate = (d: string | null) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";

export function invoiceEmailHtml(inv: any, seller: any, link: string, opts: { paid?: boolean } = {}): { subject: string; html: string } {
  const accent = seller.quote_accent || "#15C26A";
  const name = seller.business_name || "ServOS";
  const subject = opts.paid
    ? `Receipt — Invoice INV-${inv.invoice_number} from ${name} (${gbp(inv.amount_paid ?? inv.total)} paid)`
    : `Invoice INV-${inv.invoice_number} from ${name} — ${gbp(inv.total)}`;
  const statusLine = opts.paid
    ? `<div style="display:inline-block;background:#d1fae5;color:#065f46;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:1px;padding:4px 12px;border-radius:8px;margin-bottom:14px">Paid — thank you</div>`
    : (inv.due_date ? `<div style="font-size:14px;color:#555;margin-bottom:18px">Due ${fmtDate(inv.due_date)}</div>` : `<div style="margin-bottom:18px"></div>`);
  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  ${seller.logo_url ? `<img src="${seller.logo_url}" alt="${name}" style="height:40px;margin-bottom:20px" />` : `<div style="font-size:20px;font-weight:700;margin-bottom:20px">${name}</div>`}
  <div style="border:1px solid #e5e5e5;border-radius:12px;padding:24px">
    <div style="font-size:13px;color:#777;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${opts.paid ? "Receipt · " : ""}Invoice INV-${inv.invoice_number}${inv.po_number ? ` · PO ${inv.po_number}` : ""}</div>
    <div style="font-size:30px;font-weight:700;margin-bottom:8px">${gbp(opts.paid ? (inv.amount_paid ?? inv.total) : inv.total)}</div>
    ${statusLine}
    <div><a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:10px">${opts.paid ? "View invoice" : "View &amp; pay invoice"}</a></div>
    <div style="font-size:12px;color:#999;margin-top:16px">Or copy this link: <a href="${link}" style="color:${accent}">${link}</a></div>
  </div>
  <div style="font-size:12px;color:#999;margin-top:18px">${name}${seller.business_email ? ` · ${seller.business_email}` : ""}${seller.business_phone ? ` · ${seller.business_phone}` : ""}</div>
</div>`;
  return { subject, html };
}

// base64 a byte array (chunked to avoid arg-count limits), wrapped at 76 cols for MIME.
function pdfToBase64Lines(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin).replace(/(.{76})/g, "$1\r\n");
}

// Send the invoice email. Pass `attachment` to include the invoice PDF (multipart/mixed).
export async function sendInvoiceEmail(supabase: any, to: string, subject: string, html: string, attachment?: { filename: string; bytes: Uint8Array }) {
  const accessToken = await getGmailAccessToken(supabase);
  const base = [
    `From: ServOS <support@serv-os.app>`,
    `To: ${to}`,
    `Subject: ${encodeMimeWord(subject)}`,
    `MIME-Version: 1.0`,
    `Message-ID: <${crypto.randomUUID()}@serv-os.app>`,
  ];
  let raw: string;
  if (attachment) {
    const boundary = "b_" + crypto.randomUUID().replace(/-/g, "");
    raw = [
      ...base,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf; name="${attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      ``,
      pdfToBase64Lines(attachment.bytes),
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    raw = [...base, `Content-Type: text/html; charset=UTF-8`].join("\r\n") + "\r\n\r\n" + html;
  }
  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || "Gmail send failed");
  }
}
