// Server-side invoice PDF (Deno) — faithful port of src/lib/invoicePdf.js so the
// emailed PDF matches the one customers download in-app. Pure jsPDF (no DOM); the
// only browser bit (FileReader for the logo) is replaced with a fetch->base64.
// Returns the PDF as bytes for MIME attachment.
import { jsPDF } from "https://esm.sh/jspdf@4.2.1";
import autoTable from "https://esm.sh/jspdf-autotable@5.0.8";

const hexToRgb = (hex: string) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [21, 194, 106];
};
const fmtDate = (d: string | null, locale = "en-US") => {
  if (!d) return "";
  const date = new Date(String(d).length <= 10 ? d + "T00:00:00" : d);
  if (isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
};

// Deno-safe: fetch the logo and return a data URL (no FileReader). null on any failure.
async function toDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/png";
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return `data:${ct};base64,${btoa(bin)}`;
  } catch { return null; }
}

export async function buildInvoicePdfBytes({ inv = {} as any, lines = [] as any[], totals = {} as any, seller = {} as any, billTo = {} as any, fmt, taxLabel = "Tax", dateLocale = "en-US" }: any): Promise<Uint8Array> {
  const money = typeof fmt === "function" ? fmt : (n: number) => (Number(n) || 0).toFixed(2);
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 48;
  const [ar, ag, ab] = hexToRgb(seller.accent);
  const number = inv.invoice_number ?? inv.number ?? "";
  let y = M;

  // Header — seller (left) + INVOICE meta (right)
  const logoData = seller.logo_url ? await toDataUrl(seller.logo_url) : null;
  let leftBottom = y;
  if (logoData) {
    try {
      const props = doc.getImageProperties(logoData);
      const h = 40; const w = Math.min(180, (props.width / props.height) * h);
      doc.addImage(logoData, props.fileType || "PNG", M, y, w, h, undefined, "FAST");
      leftBottom = y + h + 8;
    } catch { /* fall through to text */ }
  }
  if (leftBottom === y) {
    doc.setFont("helvetica", "bold").setFontSize(18).setTextColor(20, 20, 20);
    doc.text(seller.name || "Invoice", M, y + 16);
    leftBottom = y + 28;
  }
  doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(110, 110, 110);
  const leftW = 300;
  const sellerLines: string[] = [];
  if (seller.address) sellerLines.push(...doc.splitTextToSize(String(seller.address), leftW));
  const sellerContact = [seller.email, seller.phone].filter(Boolean).join("   ·   ");
  if (sellerContact) sellerLines.push(...doc.splitTextToSize(sellerContact, leftW));
  let sy = leftBottom + 3;
  for (const line of sellerLines) { doc.text(line, M, sy); sy += 12; }
  leftBottom = sy;

  doc.setFont("helvetica", "bold").setFontSize(22).setTextColor(ar, ag, ab);
  doc.text("INVOICE", W - M, y + 16, { align: "right" });
  doc.setFontSize(10).setFont("helvetica", "normal");
  let ry = y + 38;
  const meta = [
    ["Invoice", `INV-${number}`],
    inv.po_number ? ["PO", String(inv.po_number)] : null,
    ["Issued", fmtDate(inv.issue_date, dateLocale)],
    inv.due_date ? ["Due", fmtDate(inv.due_date, dateLocale)] : null,
  ].filter(Boolean) as [string, string][];
  for (const [k, v] of meta) {
    doc.setTextColor(150, 150, 150).text(k, W - M - 140, ry);
    doc.setTextColor(40, 40, 40).text(String(v), W - M, ry, { align: "right" });
    ry += 15;
  }

  const status = (inv.status || "").toLowerCase();
  const pill = status === "paid"
    ? { t: "PAID", bg: [209, 250, 229], fg: [6, 95, 70] }
    : (inv.overdue || status === "overdue") ? { t: "OVERDUE", bg: [254, 226, 226], fg: [153, 27, 27] } : null;
  if (pill) {
    ry += 4;
    doc.setFillColor(pill.bg[0], pill.bg[1], pill.bg[2]).roundedRect(W - M - 78, ry - 11, 78, 18, 4, 4, "F");
    doc.setFont("helvetica", "bold").setFontSize(9).setTextColor(pill.fg[0], pill.fg[1], pill.fg[2]).text(pill.t, W - M - 39, ry + 1, { align: "center" });
    ry += 16;
  }

  y = Math.max(leftBottom, ry) + 14;

  // Bill To / Service location
  doc.setDrawColor(232).line(M, y, W - M, y);
  y += 20;
  const col2 = M + (W - 2 * M) / 2;
  const billW = col2 - M - 16;
  const locW = (W - M) - col2;
  const wrapParts = (parts: any[], w: number) => parts.filter(Boolean).flatMap((p) => doc.splitTextToSize(String(p), w));
  doc.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(150, 150, 150);
  doc.text("BILL TO", M, y);
  const billLines = wrapParts([billTo.companyName, billTo.companyAddress, billTo.contactName, billTo.contactEmail], billW);
  const locLines = wrapParts([billTo.locationName, billTo.locationAddress], locW);
  if (locLines.length) doc.text("SERVICE LOCATION", col2, y);
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(45, 45, 45);
  let by = y + 15;
  for (const l of (billLines.length ? billLines : ["—"])) { doc.text(l, M, by); by += 13; }
  let ly = y + 15;
  for (const l of locLines) { doc.text(l, col2, ly); ly += 13; }
  y = Math.max(by, ly) + 8;

  // Line items
  const body = (lines || [])
    .filter((l: any) => (l.name || "").trim() || Number(l.qty) || Number(l.unit_price))
    .map((l: any) => {
      const net = (Number(l.qty) || 0) * (Number(l.unit_price) || 0);
      const desc = l.description ? `${l.name}\n${l.description}` : (l.name || "");
      return [desc, String(Number(l.qty) || 0), money(l.unit_price), `${Number(l.tax_rate) || 0}%`, money(net)];
    });
  autoTable(doc, {
    startY: y,
    head: [["Description", "Qty", "Unit", taxLabel, "Amount"]],
    body: body.length ? body : [["—", "", "", "", money(0)]],
    theme: "striped",
    headStyles: { fillColor: [ar, ag, ab], textColor: 255, fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: [45, 45, 45], cellPadding: 6 },
    alternateRowStyles: { fillColor: [248, 250, 248] },
    columnStyles: { 0: { halign: "left" }, 1: { halign: "right", cellWidth: 44 }, 2: { halign: "right", cellWidth: 72 }, 3: { halign: "right", cellWidth: 52 }, 4: { halign: "right", cellWidth: 84 } },
    margin: { left: M, right: M },
  });
  y = ((doc as any).lastAutoTable?.finalY || y) + 16;

  // Totals
  const tx = W - M - 220;
  const row = (label: string, val: number, opts: any = {}) => {
    doc.setFont("helvetica", opts.bold ? "bold" : "normal").setFontSize(opts.bold ? 11 : 10);
    doc.setTextColor(...(opts.color || [90, 90, 90])).text(label, tx, y);
    doc.setTextColor(...(opts.color || [40, 40, 40])).text(money(val), W - M, y, { align: "right" });
    y += opts.bold ? 20 : 16;
  };
  row("Subtotal", totals.subtotal ?? inv.subtotal ?? 0);
  row(taxLabel, totals.tax ?? inv.tax_amount ?? 0);
  doc.setDrawColor(225).line(tx, y - 6, W - M, y - 6);
  row("Total", totals.total ?? inv.total ?? 0, { bold: true, color: [ar, ag, ab] });
  if (status === "paid") {
    const paid = totals.paid ?? inv.amount_paid ?? totals.total ?? inv.total ?? 0;
    row("Paid", paid, { color: [6, 120, 70] });
    const bal = (Number(totals.total ?? inv.total ?? 0) - Number(paid));
    if (Math.abs(bal) > 0.005) row("Balance due", bal, { bold: true });
  }
  y += 8;

  // Notes + terms
  const block = (title: string, text: string) => {
    if (!text) return;
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = M; }
    doc.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(150, 150, 150).text(title, M, y);
    y += 13;
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(80, 80, 80);
    const wrapped = doc.splitTextToSize(String(text), W - 2 * M);
    doc.text(wrapped, M, y);
    y += wrapped.length * 12 + 10;
  };
  block("NOTES", inv.notes);
  block("TERMS", inv.terms);

  // Footer
  const fy = doc.internal.pageSize.getHeight() - 36;
  doc.setDrawColor(238).line(M, fy - 12, W - M, fy - 12);
  doc.setFont("helvetica", "normal").setFontSize(8.5).setTextColor(160, 160, 160);
  doc.text([seller.name, seller.email, seller.phone].filter(Boolean).join("   ·   ") || "Thank you for your business", M, fy);
  doc.text(`INV-${number}`, W - M, fy, { align: "right" });

  return new Uint8Array(doc.output("arraybuffer"));
}
