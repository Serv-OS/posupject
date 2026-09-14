// Shared helper: send a branded invoice email from the connected support
// mailbox (gmail_connections). Used by invoice-send and invoice-recurring,
// and by credit-note-send for credit notes. Also home to balanceDue, the one
// "what is still owed" rule every invoice function uses.
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

// Currency-aware formatter. GBP was hardcoded here (£ in subject lines, £ in
// the headline figure, £ into the PDF), so a USD invoice would have emailed as
// pounds with no error anywhere. The invoice's own currency column decides.
export const moneyFor = (currency?: string | null) => {
  const c = currency === "USD" ? "USD" : "GBP";
  const loc = c === "USD" ? "en-US" : "en-GB";
  return (n: number) => new Intl.NumberFormat(loc, { style: "currency", currency: c }).format(Number(n) || 0);
};
// No fixed-GBP export on purpose: every caller passes the row's own currency.
export const taxLabelFor = (currency?: string | null) => (currency === "USD" ? "Sales tax" : "VAT");
export const dateLocaleFor = (currency?: string | null) => (currency === "USD" ? "en-US" : "en-GB");
const fmtDate = (d: string | null, locale = "en-GB") => d ? new Date(d + "T00:00:00").toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" }) : "";

// ── Balance due ─────────────────────────────────────────────────────────────
// What the customer still owes: total less payments less credit notes less
// credit applied to it from other invoices' credit notes, never below 0. The
// SAME rule as balanceDue in src/lib/creditNotes.js, repeated here because Deno
// cannot import src/lib. Keep the two in step, or the public page would show
// one balance and Stripe charge another.
//
// Credit applied (invoices.amount_allocated, the credit allocations migration)
// is a settlement, not cash: amount_paid stays the cash received, and only the
// balance comes down.
//
// Invoice totals are stored unrounded (3 x 33.33 at 20% is saved as 119.988),
// so the sum is done on exact decimals and rounded once: to 6 places to wash
// out float noise the browser saved (150.01500000000001), then to the penny,
// half up. Plain floats disagree by a penny at exactly half a penny:
// Math.round(1234.995 * 100) charges 1234.99 for an invoice every screen shows
// as 1,235.00.
//
// A paid invoice with no amount_paid was paid in full, as the invoice screens
// already show it (amount_paid ?? total), less whatever credit applied to it
// settled. A row without amount_credited or amount_allocated (a migration not
// applied yet) counts as no credit.
type Dec = { n: bigint; s: number };   // the value n / 10^s
const DZERO: Dec = { n: 0n, s: 0 };
// The number shapes the database and src/lib/creditNotes.js accept.
const NUMBER_TEXT = /^\s*([+-]?)(?:(\d+)\.?(\d*)|\.(\d+))(?:[eE]([+-]?\d{1,3}))?\s*$/;

// A JS number is read through String(), the same text supabase-js parsed it
// from, so this starts from the decimal the database holds. Anything else is 0.
function toDec(v: unknown): Dec {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return DZERO;
    v = String(v);
  }
  if (typeof v !== "string") return DZERO;
  const m = v.match(NUMBER_TEXT);
  if (!m) return DZERO;
  const [, sign, whole = "", fracA, fracB, exp = "0"] = m;
  const frac = fracA ?? fracB ?? "";
  let s = frac.length - Number(exp);
  let n = BigInt(`${sign === "-" ? "-" : ""}${whole}${frac}`);
  if (s < 0) { n *= 10n ** BigInt(-s); s = 0; }
  return { n, s };
}
const atScale = (a: Dec, s: number) => a.n * 10n ** BigInt(s - a.s);
const addDec = (a: Dec, b: Dec): Dec => { const s = Math.max(a.s, b.s); return { n: atScale(a, s) + atScale(b, s), s }; };
const subDec = (a: Dec, b: Dec): Dec => addDec(a, { n: -b.n, s: b.s });
// Half away from zero, which is what Postgres round(numeric, dp) does.
function roundDec(a: Dec, dp: number): Dec {
  if (a.s <= dp) return { n: atScale(a, dp), s: dp };
  const f = 10n ** BigInt(a.s - dp);
  const neg = a.n < 0n;
  const abs = neg ? -a.n : a.n;
  let q = abs / f;
  if ((abs % f) * 2n >= f) q += 1n;
  return { n: neg ? -q : q, s: dp };
}
const penniesDec = (a: Dec) => roundDec(roundDec(a, 6), 2);
function decToNumber(a: Dec): number {
  const neg = a.n < 0n;
  const digits = (neg ? -a.n : a.n).toString().padStart(a.s + 1, "0");
  const cut = digits.length - a.s;
  // `|| 0` so a zero never comes back as -0.
  return Number(`${neg ? "-" : ""}${digits.slice(0, cut)}.${digits.slice(cut) || "0"}`) || 0;
}
const max0Dec = (a: Dec): Dec => (a.n > 0n ? a : DZERO);
// The cash taken. A paid invoice with no amount_paid was paid in full, less
// what credit applied to it settled: the database reads it the same way.
function paidDec(inv: any): Dec {
  if (inv?.amount_paid != null && inv.amount_paid !== "") return toDec(inv.amount_paid);
  return inv?.status === "paid" ? max0Dec(subDec(toDec(inv.total), toDec(inv.amount_allocated))) : DZERO;
}

/** Money figures added up exactly and rounded to the penny by the rule above. */
export const addPennies = (...values: unknown[]): number =>
  decToNumber(penniesDec(values.reduce<Dec>((sum, v) => addDec(sum, toDec(v)), DZERO)));

/**
 * What is still owed on an invoice, in pennies: total - paid - credited -
 * credit applied, never below 0.
 */
export function balanceDue(inv: any): number {
  const due = penniesDec(subDec(subDec(subDec(toDec(inv?.total), paidDec(inv)), toDec(inv?.amount_credited)), toDec(inv?.amount_allocated)));
  return due.n > 0n ? decToNumber(due) : 0;
}

/**
 * The cash taken on an invoice, in pennies: amountPaid in src/lib/creditNotes.js.
 * Credit applied from another invoice is not cash and is not in here.
 */
export const amountPaidOn = (inv: any): number => decToNumber(penniesDec(paidDec(inv)));

/** Credit applied to an invoice from other invoices' credit notes, in pennies (0 without the column). */
export const amountAllocated = (inv: any): number => decToNumber(penniesDec(max0Dec(toDec(inv?.amount_allocated))));

/**
 * Whether two rows (an invoice, a credit note) are for the same customer: the
 * same company, or with no company on either, the same contact. The public
 * pages only link across to the other side of applied credit when this holds.
 */
export const sameCustomer = (a: any, b: any): boolean =>
  a?.company_id || b?.company_id
    ? !!a?.company_id && a.company_id === b?.company_id
    : !!a?.contact_id && a.contact_id === b?.contact_id;

// ── What a credit note's credit has been used for ───────────────────────────
// The SAME rules as creditUse and creditAvailable in src/lib/creditNotes.js.
// refund_due is all the money a note hands back. Of it, amount_allocated has
// been applied to other invoices and refunded_amount refunded; the rest is
// credit available, and only while refund_status is owed. A note refunded
// before refunded_amount existed had its whole refund_due refunded.
function noteRefundedDec(note: any): Dec {
  if (note?.refunded_amount != null && note.refunded_amount !== "") return toDec(note.refunded_amount);
  return note?.refund_status === "refunded" ? max0Dec(subDec(toDec(note.refund_due), toDec(note.amount_allocated))) : DZERO;
}

/**
 * How a credit note's credit has been used, in pennies: used (applied to
 * invoices), refunded, and left (credit available, 0 unless the note is issued
 * with refund_status owed).
 */
export function creditUse(note: any): { used: number; refunded: number; left: number } {
  const refunded = noteRefundedDec(note);
  const left = note?.status === "issued" && note.refund_status === "owed"
    ? max0Dec(penniesDec(subDec(subDec(toDec(note.refund_due), toDec(note.amount_allocated)), refunded)))
    : DZERO;
  return {
    used: decToNumber(penniesDec(toDec(note?.amount_allocated))),
    refunded: decToNumber(penniesDec(refunded)),
    left: decToNumber(left),
  };
}

// Staff type the reason freely; it must reach the customer as text, never as
// markup.
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function invoiceEmailHtml(inv: any, seller: any, link: string, opts: { paid?: boolean } = {}): { subject: string; html: string } {
  const accent = seller.quote_accent || "#15C26A";
  const name = seller.business_name || "ServOS";
  const fmt = moneyFor(inv.currency);
  // The cash taken: credit applied from another invoice is not money paid.
  const cash = amountPaidOn(inv);
  const subject = opts.paid
    ? `Receipt — Invoice INV-${inv.invoice_number} from ${name} (${fmt(cash)} paid)`
    : `Invoice INV-${inv.invoice_number} from ${name} — ${fmt(inv.total)}`;
  const statusLine = opts.paid
    ? `<div style="display:inline-block;background:#d1fae5;color:#065f46;font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:1px;padding:4px 12px;border-radius:8px;margin-bottom:14px">Paid — thank you</div>`
    : (inv.due_date ? `<div style="font-size:14px;color:#555;margin-bottom:18px">Due ${fmtDate(inv.due_date, dateLocaleFor(inv.currency))}</div>` : `<div style="margin-bottom:18px"></div>`);
  // Once a credit note, or credit applied from another invoice's credit note,
  // has taken something off, the total alone asks for more than is owed, so
  // say what is left: the figure the pay page charges. A receipt for an
  // invoice that credit helped to settle says how much credit that was, since
  // the figure paid is less than the total. An invoice with no credit gets
  // exactly the email it always did.
  const credited = Number(inv.amount_credited) || 0;
  const allocated = amountAllocated(inv);
  const left = balanceDue(inv);
  const creditParts = [
    credited > 0 ? `${fmt(credited)} credited` : "",
    allocated > 0 ? `${fmt(allocated)} credit applied` : "",
  ].filter(Boolean);
  const creditLine = !opts.paid && creditParts.length
    ? `<div style="font-size:14px;color:#555;margin-bottom:6px">${creditParts.join(" · ")} · ${left > 0 ? `${fmt(left)} left to pay` : "nothing left to pay"}</div>`
    : opts.paid && allocated > 0
      ? `<div style="font-size:14px;color:#555;margin-bottom:6px">${fmt(allocated)} credit applied</div>`
      : "";
  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  ${seller.logo_url ? `<img src="${seller.logo_url}" alt="${name}" style="height:40px;margin-bottom:20px" />` : `<div style="font-size:20px;font-weight:700;margin-bottom:20px">${name}</div>`}
  <div style="border:1px solid #e5e5e5;border-radius:12px;padding:24px">
    <div style="font-size:13px;color:#777;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">${opts.paid ? "Receipt · " : ""}Invoice INV-${inv.invoice_number}${inv.po_number ? ` · PO ${inv.po_number}` : ""}</div>
    <div style="font-size:30px;font-weight:700;margin-bottom:8px">${fmt(opts.paid ? cash : inv.total)}</div>
    ${creditLine}${statusLine}
    <div><a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:10px">${opts.paid || (creditParts.length && left <= 0) ? "View invoice" : "View &amp; pay invoice"}</a></div>
    <div style="font-size:12px;color:#999;margin-top:16px">Or copy this link: <a href="${link}" style="color:${accent}">${link}</a></div>
  </div>
  <div style="font-size:12px;color:#999;margin-top:18px">${name}${seller.business_email ? ` · ${seller.business_email}` : ""}${seller.business_phone ? ` · ${seller.business_phone}` : ""}</div>
</div>`;
  return { subject, html };
}

// The credit note email, in the invoice email's look. `note` is the
// credit_notes row and `inv` its invoice as it stands now, so amount_credited
// already includes this note and the balance shown is today's balance.
// `applied` is optional: the note's active credit allocations as
// [{ invoice_number, amount }], for one line per invoice. Without it, credit
// already used shows as one line.
export function creditNoteEmailHtml(note: any, inv: any, seller: any, link: string, applied: any[] = []): { subject: string; html: string } {
  const accent = seller.quote_accent || "#15C26A";
  const name = seller.business_name || "ServOS";
  // A credit note always carries its invoice's currency; the invoice is the
  // fallback for a row that somehow has none.
  const currency = note.currency || inv.currency;
  const fmt = moneyFor(currency);
  const locale = dateLocaleFor(currency);
  const cn = `CN-${note.credit_number}`;
  const invNo = `INV-${inv.invoice_number}`;
  const subject = `Credit note ${cn} for invoice ${invNo}`;

  // Where this leaves the customer. Money handed back (credit available,
  // applied to another invoice, or refunded) matters more than the balance,
  // which is 0 whenever there is any. A void invoice asks for nothing, so it
  // gets no balance line at all.
  const box = (text: string, bg = "#f4f4f5", color = "#1a1a1a") =>
    `<div style="background:${bg};color:${color};border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:18px">${text}</div>`;
  const lines: string[] = [];
  if (note.status !== "cancelled" && ["owed", "allocated", "refunded"].includes(note.refund_status)) {
    const use = creditUse(note);
    const rows = (applied || []).filter((a: any) => a && !a.removed_at && Number(a.amount) > 0);
    if (rows.length) {
      for (const a of rows) lines.push(`Applied to invoice INV-${esc(a.invoice_number)}: <b>${fmt(a.amount)}</b>`);
    } else if (use.used > 0) {
      lines.push(`Applied to your other invoices: <b>${fmt(use.used)}</b>`);
    }
    if (use.refunded > 0) {
      const on = note.refunded_at ? ` on ${fmtDate(String(note.refunded_at).slice(0, 10), locale)}` : "";
      lines.push(`Refunded to you: <b>${fmt(use.refunded)}</b>${on}`);
    }
    if (use.left > 0) {
      lines.push(use.used > 0 || use.refunded > 0
        ? `Credit left: <b>${fmt(use.left)}</b>`
        : `Credit available to you: <b>${fmt(use.left)}</b><br><span style="font-size:13px">It can be paid back to you or taken off another invoice.</span>`);
    }
  }
  let outcome = "";
  if (lines.length) {
    outcome = box(lines.join("<br>"), "#d1fae5", "#065f46");
  } else if (inv.status !== "void") {
    const due = balanceDue(inv);
    outcome = box(due > 0 ? `Left to pay on invoice ${invNo}: <b>${fmt(due)}</b>` : `Nothing left to pay on invoice ${invNo}.`);
  }

  const html = `
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a">
  ${seller.logo_url ? `<img src="${seller.logo_url}" alt="${esc(name)}" style="height:40px;margin-bottom:20px" />` : `<div style="font-size:20px;font-weight:700;margin-bottom:20px">${esc(name)}</div>`}
  <div style="border:1px solid #e5e5e5;border-radius:12px;padding:24px">
    <div style="font-size:13px;color:#777;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Credit note ${cn} · Invoice ${invNo}</div>
    <div style="font-size:30px;font-weight:700;margin-bottom:4px">${fmt(note.total)}</div>
    <div style="font-size:14px;color:#555;margin-bottom:16px">Credited${note.issue_date ? ` on ${fmtDate(note.issue_date, locale)}` : ""}</div>
    ${note.reason ? `<div style="font-size:14px;color:#333;margin-bottom:16px;white-space:pre-wrap"><b>Reason:</b> ${esc(note.reason)}</div>` : ""}
    ${outcome}
    <div><a href="${link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:10px">View credit note</a></div>
    <div style="font-size:12px;color:#999;margin-top:16px">Or copy this link: <a href="${link}" style="color:${accent}">${link}</a></div>
  </div>
  <div style="font-size:12px;color:#999;margin-top:18px">${esc(name)}${seller.business_email ? ` · ${esc(seller.business_email)}` : ""}${seller.business_phone ? ` · ${esc(seller.business_phone)}` : ""}</div>
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
