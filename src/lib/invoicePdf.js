// One-click invoice → PDF. Pure client-side (jsPDF), lazy-loaded by the
// InvoiceBuilder so jsPDF stays out of the main bundle. buildInvoiceDoc is kept
// pure (returns the doc) so it can be unit-tested in Node; downloadInvoicePdf
// wraps it with the browser save().
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'

const hexToRgb = (hex) => {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '')
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [21, 194, 106]
}

const fmtDate = (d, locale = 'en-US') => {
  if (!d) return ''
  const date = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d)
  if (isNaN(date)) return String(d)
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

// Best-effort: turn a remote logo URL into a data URL for embedding. Returns
// null on any failure (CORS, 404, non-image) so the PDF falls back to text.
async function toDataUrl(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    return await new Promise((resolve) => {
      const r = new FileReader()
      r.onloadend = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => resolve(null)
      r.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export async function buildInvoiceDoc({ inv = {}, lines = [], totals = {}, seller = {}, billTo = {}, fmt, taxLabel = 'Tax', dateLocale = 'en-US' }) {
  const money = typeof fmt === 'function' ? fmt : (n) => (Number(n) || 0).toFixed(2)
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const M = 48
  const [ar, ag, ab] = hexToRgb(seller.accent)
  const number = inv.invoice_number ?? inv.number ?? ''
  let y = M

  // ── Header — seller (left) + INVOICE meta (right) ──────────────────────────
  const logoData = seller.logo_url ? await toDataUrl(seller.logo_url) : null
  let leftBottom = y
  if (logoData) {
    try {
      const props = doc.getImageProperties(logoData)
      const h = 40
      const w = Math.min(180, (props.width / props.height) * h)
      doc.addImage(logoData, props.fileType || 'PNG', M, y, w, h, undefined, 'FAST')
      leftBottom = y + h + 8
    } catch {
      // fall through to text name
    }
  }
  if (leftBottom === y) {
    doc.setFont('helvetica', 'bold').setFontSize(18).setTextColor(20, 20, 20)
    doc.text(seller.name || 'Invoice', M, y + 16)
    leftBottom = y + 28
  }
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110, 110, 110)
  for (const line of [seller.address, [seller.email, seller.phone].filter(Boolean).join('   ·   ')].filter(Boolean)) {
    doc.text(String(line), M, leftBottom + 3)
    leftBottom += 13
  }

  doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(ar, ag, ab)
  doc.text('INVOICE', W - M, y + 16, { align: 'right' })
  doc.setFontSize(10).setFont('helvetica', 'normal')
  let ry = y + 38
  const meta = [
    ['Invoice', `INV-${number}`],
    inv.po_number ? ['PO', String(inv.po_number)] : null,
    ['Issued', fmtDate(inv.issue_date, dateLocale)],
    inv.due_date ? ['Due', fmtDate(inv.due_date, dateLocale)] : null,
  ].filter(Boolean)
  for (const [k, v] of meta) {
    doc.setTextColor(150, 150, 150).text(k, W - M - 140, ry)
    doc.setTextColor(40, 40, 40).text(String(v), W - M, ry, { align: 'right' })
    ry += 15
  }

  // status pill
  const status = (inv.status || '').toLowerCase()
  const pill = status === 'paid'
    ? { t: 'PAID', bg: [209, 250, 229], fg: [6, 95, 70] }
    : (inv.overdue || status === 'overdue') ? { t: 'OVERDUE', bg: [254, 226, 226], fg: [153, 27, 27] }
      : null
  if (pill) {
    ry += 4
    doc.setFillColor(...pill.bg).roundedRect(W - M - 78, ry - 11, 78, 18, 4, 4, 'F')
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...pill.fg).text(pill.t, W - M - 39, ry + 1, { align: 'center' })
    ry += 16
  }

  y = Math.max(leftBottom, ry) + 14

  // ── Bill To / Service location ─────────────────────────────────────────────
  doc.setDrawColor(232).line(M, y, W - M, y)
  y += 20
  const col2 = M + (W - 2 * M) / 2
  doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(150, 150, 150)
  doc.text('BILL TO', M, y)
  const billLines = [billTo.companyName, billTo.companyAddress, billTo.contactName, billTo.contactEmail].filter(Boolean)
  const locLines = [billTo.locationName, billTo.locationAddress].filter(Boolean)
  if (locLines.length) doc.text('SERVICE LOCATION', col2, y)
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(45, 45, 45)
  let by = y + 15
  for (const l of (billLines.length ? billLines : ['—'])) { doc.text(String(l), M, by); by += 13 }
  let ly = y + 15
  for (const l of locLines) { doc.text(String(l), col2, ly); ly += 13 }
  y = Math.max(by, ly) + 8

  // ── Line items ─────────────────────────────────────────────────────────────
  const body = (lines || [])
    .filter((l) => (l.name || '').trim() || Number(l.qty) || Number(l.unit_price))
    .map((l) => {
      const net = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
      const desc = l.description ? `${l.name}\n${l.description}` : (l.name || '')
      return [desc, String(Number(l.qty) || 0), money(l.unit_price), `${Number(l.tax_rate) || 0}%`, money(net)]
    })
  autoTable(doc, {
    startY: y,
    head: [['Description', 'Qty', 'Unit', taxLabel, 'Amount']],
    body: body.length ? body : [['—', '', '', '', money(0)]],
    theme: 'striped',
    headStyles: { fillColor: [ar, ag, ab], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: [45, 45, 45], cellPadding: 6 },
    alternateRowStyles: { fillColor: [248, 250, 248] },
    columnStyles: {
      0: { halign: 'left' },
      1: { halign: 'right', cellWidth: 44 },
      2: { halign: 'right', cellWidth: 72 },
      3: { halign: 'right', cellWidth: 52 },
      4: { halign: 'right', cellWidth: 84 },
    },
    margin: { left: M, right: M },
  })
  y = (doc.lastAutoTable?.finalY || y) + 16

  // ── Totals (right column) ──────────────────────────────────────────────────
  const tx = W - M - 220
  const row = (label, val, opts = {}) => {
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal').setFontSize(opts.bold ? 11 : 10)
    doc.setTextColor(...(opts.color || [90, 90, 90])).text(label, tx, y)
    doc.setTextColor(...(opts.color || [40, 40, 40])).text(money(val), W - M, y, { align: 'right' })
    y += opts.bold ? 20 : 16
  }
  row('Subtotal', totals.subtotal ?? inv.subtotal ?? 0)
  row(taxLabel, totals.tax ?? inv.tax_amount ?? 0)
  doc.setDrawColor(225).line(tx, y - 6, W - M, y - 6)
  row('Total', totals.total ?? inv.total ?? 0, { bold: true, color: [ar, ag, ab] })
  if (status === 'paid') {
    const paid = totals.paid ?? inv.amount_paid ?? totals.total ?? inv.total ?? 0
    row('Paid', paid, { color: [6, 120, 70] })
    const bal = (Number(totals.total ?? inv.total ?? 0) - Number(paid))
    if (Math.abs(bal) > 0.005) row('Balance due', bal, { bold: true })
  }
  y += 8

  // ── Notes + terms ──────────────────────────────────────────────────────────
  const block = (title, text) => {
    if (!text) return
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = M }
    doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(150, 150, 150).text(title, M, y)
    y += 13
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(80, 80, 80)
    const wrapped = doc.splitTextToSize(String(text), W - 2 * M)
    doc.text(wrapped, M, y)
    y += wrapped.length * 12 + 10
  }
  block('NOTES', inv.notes)
  block('TERMS', inv.terms)

  // ── Footer ─────────────────────────────────────────────────────────────────
  const fy = doc.internal.pageSize.getHeight() - 36
  doc.setDrawColor(238).line(M, fy - 12, W - M, fy - 12)
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(160, 160, 160)
  doc.text([seller.name, seller.email, seller.phone].filter(Boolean).join('   ·   ') || 'Thank you for your business', M, fy)
  doc.text(`INV-${number}`, W - M, fy, { align: 'right' })

  return doc
}

export async function downloadInvoicePdf(data) {
  const doc = await buildInvoiceDoc(data)
  const number = data?.inv?.invoice_number ?? data?.inv?.number ?? 'invoice'
  doc.save(`INV-${number}.pdf`)
}
