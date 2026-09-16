// One-click invoice → PDF. Pure client-side (jsPDF), lazy-loaded by the
// InvoiceBuilder so jsPDF stays out of the main bundle. buildInvoiceDoc is kept
// pure (returns the doc) so it can be unit-tested in Node; downloadInvoicePdf
// wraps it with the browser save().
//
// The credit note is the same document with different words, so both are drawn
// by the one set of layout pieces below (header, customer block, line table,
// totals column, text blocks, footer). Change the look there and the invoice
// and the credit note stay matched.
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import { amountPaid, balanceDue, creditableLeft, creditNoteLabel, creditNoteStatusKind, creditNoteStatusLabel, creditState, creditTotals, creditUse, settledAmount } from './creditNotes.js'

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

const moneyFn = (fmt) => (typeof fmt === 'function' ? fmt : (n) => (Number(n) || 0).toFixed(2))

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

// ── Shared layout ────────────────────────────────────────────────────────────
// Every piece draws at ctx.y and moves it on, so the pieces can be stacked in
// whatever order a document needs.
function startDoc(seller = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  return { doc, W: doc.internal.pageSize.getWidth(), M: 48, y: 48, accent: hexToRgb(seller.accent) }
}

// Seller (left) + document title, meta rows and status pill (right).
async function drawHeader(ctx, { seller = {}, title, fallbackName, meta = [], pill = null }) {
  const { doc, W, M } = ctx
  const [ar, ag, ab] = ctx.accent
  const y = ctx.y

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
    doc.text(seller.name || fallbackName, M, y + 16)
    leftBottom = y + 28
  }
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(110, 110, 110)
  const leftW = 300 // keep seller text clear of the right-hand meta column
  const sellerLines = []
  if (seller.address) sellerLines.push(...doc.splitTextToSize(String(seller.address), leftW))
  const sellerContact = [seller.email, seller.phone].filter(Boolean).join('   ·   ')
  if (sellerContact) sellerLines.push(...doc.splitTextToSize(sellerContact, leftW))
  let sy = leftBottom + 3
  for (const line of sellerLines) { doc.text(line, M, sy); sy += 12 }
  leftBottom = sy

  doc.setFont('helvetica', 'bold').setFontSize(22).setTextColor(ar, ag, ab)
  doc.text(title, W - M, y + 16, { align: 'right' })
  doc.setFontSize(10).setFont('helvetica', 'normal')
  let ry = y + 38
  for (const [k, v] of meta.filter(Boolean)) {
    doc.setTextColor(150, 150, 150).text(k, W - M - 140, ry)
    doc.setTextColor(40, 40, 40).text(String(v), W - M, ry, { align: 'right' })
    ry += 15
  }

  if (pill) {
    ry += 4
    // 78pt wide, or wider for longer words (USED ON INV-1050), so the text
    // never runs out of its pill. Words too long for the space right of the
    // seller's details (credit used on several invoices) give way to
    // pill.short when there is one.
    doc.setFont('helvetica', 'bold').setFontSize(9)
    const text = pill.short && Math.ceil(doc.getTextWidth(pill.t)) + 16 > 190 ? pill.short : pill.t
    const pw = Math.max(78, Math.ceil(doc.getTextWidth(text)) + 16)
    doc.setFillColor(...pill.bg).roundedRect(W - M - pw, ry - 11, pw, 18, 4, 4, 'F')
    doc.setTextColor(...pill.fg).text(text, W - M - pw / 2, ry + 1, { align: 'center' })
    ry += 16
  }

  ctx.y = Math.max(leftBottom, ry) + 14
}

// Customer (left) / Service location (right), each wrapped to its own column.
function drawParties(ctx, { billTo = {}, label }) {
  const { doc, W, M } = ctx
  let y = ctx.y
  doc.setDrawColor(232).line(M, y, W - M, y)
  y += 20
  const col2 = M + (W - 2 * M) / 2
  const billW = col2 - M - 16   // wrap each column to its own width so they never collide
  const locW = (W - M) - col2
  const wrapParts = (parts, w) => parts.filter(Boolean).flatMap((p) => doc.splitTextToSize(String(p), w))
  doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(150, 150, 150)
  doc.text(label, M, y)
  const billLines = wrapParts([billTo.companyName, billTo.companyAddress, billTo.contactName, billTo.contactEmail], billW)
  const locLines = wrapParts([billTo.locationName, billTo.locationAddress], locW)
  if (locLines.length) doc.text('SERVICE LOCATION', col2, y)
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(45, 45, 45)
  let by = y + 15
  for (const l of (billLines.length ? billLines : ['—'])) { doc.text(l, M, by); by += 13 }
  let ly = y + 15
  for (const l of locLines) { doc.text(l, col2, ly); ly += 13 }
  ctx.y = Math.max(by, ly) + 8
}

function drawLines(ctx, { lines, taxLabel, money }) {
  const { doc, M } = ctx
  const [ar, ag, ab] = ctx.accent
  const body = (lines || [])
    .filter((l) => (l.name || '').trim() || Number(l.qty) || Number(l.unit_price))
    .map((l) => {
      const net = (Number(l.qty) || 0) * (Number(l.unit_price) || 0)
      const desc = l.description ? `${l.name}\n${l.description}` : (l.name || '')
      return [desc, String(Number(l.qty) || 0), money(l.unit_price), `${Number(l.tax_rate) || 0}%`, money(net)]
    })
  autoTable(doc, {
    startY: ctx.y,
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
  ctx.y = (doc.lastAutoTable?.finalY || ctx.y) + 16
}

// The right-hand totals column. Each row is [label, value, opts]: opts.bold
// for the headline figure, opts.color, opts.rule for the divider above it,
// opts.minus for a figure taken off (credit, payments), and opts.note for a
// small line of text under the row.
function drawTotals(ctx, rows, money) {
  const { doc, W, M } = ctx
  const tx = W - M - 220
  for (const r of rows.filter(Boolean)) {
    const [label, val, opts = {}] = r
    // A long credit note or invoice can end its lines near the foot of the
    // page; the refund or balance row would then print over the footer or off
    // the page. Room for a row and its note, as the invoice lines leave.
    if (ctx.y > doc.internal.pageSize.getHeight() - 70) { doc.addPage(); ctx.y = M }
    // ctx.y is the row's baseline. The divider used to sit 6pt above it, which
    // ran through the middle of "Total" like a strike through; on a credit note
    // that reads as cancelled. 11pt clears the row above and the text below.
    if (opts.rule) doc.setDrawColor(225).line(tx, ctx.y - 11, W - M, ctx.y - 11)
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal').setFontSize(opts.bold ? 11 : 10)
    doc.setTextColor(...(opts.color || [90, 90, 90])).text(label, tx, ctx.y)
    // A plain hyphen: the PDF's built-in font has no minus sign.
    doc.setTextColor(...(opts.color || [40, 40, 40])).text(`${opts.minus ? '-' : ''}${money(val)}`, W - M, ctx.y, { align: 'right' })
    ctx.y += opts.bold ? 20 : 16
    if (opts.note) {
      doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(130, 130, 130).text(String(opts.note), tx, ctx.y - 4)
      ctx.y += 10
    }
  }
  ctx.y += 8
}

// A titled paragraph (notes, terms, the credit reason). Skipped when empty.
function drawBlock(ctx, title, text) {
  if (!text) return
  const { doc, W, M } = ctx
  if (ctx.y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); ctx.y = M }
  doc.setFont('helvetica', 'bold').setFontSize(8.5).setTextColor(150, 150, 150).text(title, M, ctx.y)
  ctx.y += 13
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(80, 80, 80)
  const wrapped = doc.splitTextToSize(String(text), W - 2 * M)
  doc.text(wrapped, M, ctx.y)
  ctx.y += wrapped.length * 12 + 10
}

function drawFooter(ctx, seller = {}, label) {
  const { doc, W, M } = ctx
  const fy = doc.internal.pageSize.getHeight() - 36
  doc.setDrawColor(238).line(M, fy - 12, W - M, fy - 12)
  doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(160, 160, 160)
  doc.text([seller.name, seller.email, seller.phone].filter(Boolean).join('   ·   ') || 'Thank you for your business', M, fy)
  doc.text(label, W - M, fy, { align: 'right' })
}

// ── Invoice ──────────────────────────────────────────────────────────────────
// allocations (optional): the credit applied to this invoice from other
// invoices' credit notes, as credit_allocations rows or the public page's rows,
// each { credit_number or number or credit_note: { credit_number }, amount,
// removed_at }. Removed ones are left out. Each prints as "Credit applied
// CN-1001" above the balance due. Without them, inv.amount_allocated (or
// totals.allocated) still prints as one "Credit applied" row.
export async function buildInvoiceDoc({ inv = {}, lines = [], totals = {}, seller = {}, billTo = {}, allocations = [], fmt, taxLabel = 'Tax', dateLocale = 'en-US' }) {
  const money = moneyFn(fmt)
  const ctx = startDoc(seller)
  const number = inv.invoice_number ?? inv.number ?? ''

  const status = (inv.status || '').toLowerCase()
  const total = totals.total ?? inv.total ?? 0

  // Credit notes and credit applied from other invoices (src/lib/creditNotes.js).
  // With neither, everything below reads exactly as it did before credit notes
  // existed. Credit applied is a settlement, not a payment: it has rows of its
  // own and never adds to Paid.
  const credited = Number(totals.credited ?? inv.amount_credited) || 0
  const allocated = Number(totals.allocated ?? inv.amount_allocated) || 0
  const hasCredit = credited > 0 || allocated > 0
  const state = { status, total, amount_paid: totals.paid ?? inv.amount_paid, amount_credited: credited, amount_allocated: allocated }
  const balance = balanceDue(state)
  const paid = amountPaid(state)
  const applied = (allocations || []).filter((a) => a && !a.removed_at && Number(a.amount) > 0)
  const appliedRows = applied.length ? applied : allocated > 0 ? [{ amount: allocated }] : []

  // Fully credited with nothing paid is not overdue: nothing is owed.
  const pill = status === 'paid'
    ? { t: 'PAID', bg: [209, 250, 229], fg: [6, 95, 70] }
    : (credited > 0 && creditState(state) === 'full' && paid === 0) ? { t: 'CREDITED', bg: [224, 231, 255], fg: [55, 48, 163] }
      : ((inv.overdue || status === 'overdue') && !(hasCredit && balance === 0)) ? { t: 'OVERDUE', bg: [254, 226, 226], fg: [153, 27, 27] }
        : null
  await drawHeader(ctx, {
    seller, title: 'INVOICE', fallbackName: 'Invoice', pill,
    meta: [
      ['Invoice', `INV-${number}`],
      inv.po_number ? ['PO', String(inv.po_number)] : null,
      ['Issued', fmtDate(inv.issue_date, dateLocale)],
      inv.due_date ? ['Due', fmtDate(inv.due_date, dateLocale)] : null,
    ],
  })
  drawParties(ctx, { billTo, label: 'BILL TO' })
  drawLines(ctx, { lines, taxLabel, money })

  const [ar, ag, ab] = ctx.accent
  const rows = [
    ['Subtotal', totals.subtotal ?? inv.subtotal ?? 0],
    [taxLabel, totals.tax ?? inv.tax_amount ?? 0],
    ['Total', total, { bold: true, color: [ar, ag, ab], rule: true }],
  ]
  if (hasCredit) {
    // The customer pays the balance, so every step down to it is shown.
    if (credited > 0) rows.push(['Credited', credited, { minus: true }])
    for (const a of appliedRows) {
      const label = creditNoteLabel(a.credit_number ?? a.number ?? a.credit_note?.credit_number)
      rows.push([label ? `Credit applied ${label}` : 'Credit applied', a.amount, { minus: true }])
    }
    if (paid > 0) rows.push(['Paid', paid, { color: [6, 120, 70], minus: true }])
    // Paid in full and then credited: the balance stops at 0, so say where the
    // rest went rather than print sums that do not add up. The credit note
    // itself says whether it has been refunded. Settled is cash plus credit
    // applied, both in pennies.
    const over = settledAmount(state) - creditableLeft(state)
    rows.push(['Balance due', balance, { bold: true, note: over > 0.005 ? `${money(over)} more was paid than is now owed` : null }])
  } else if (status === 'paid') {
    const paid = totals.paid ?? inv.amount_paid ?? totals.total ?? inv.total ?? 0
    rows.push(['Paid', paid, { color: [6, 120, 70] }])
    const bal = (Number(totals.total ?? inv.total ?? 0) - Number(paid))
    if (Math.abs(bal) > 0.005) rows.push(['Balance due', bal, { bold: true }])
  } else if (status !== 'draft' && status !== 'void' && paid > 0) {
    // Part paid with no credit (a payment recorded, or a deposit): what came in
    // and what is left, as the public invoice page and the email show it.
    rows.push(['Paid', paid, { color: [6, 120, 70], minus: true }])
    rows.push(['Balance due', balance, { bold: true }])
  }
  drawTotals(ctx, rows, money)

  drawBlock(ctx, 'NOTES', inv.notes)
  drawBlock(ctx, 'TERMS', inv.terms)
  drawFooter(ctx, seller, `INV-${number}`)
  return ctx.doc
}

export async function downloadInvoicePdf(data) {
  const doc = await buildInvoiceDoc(data)
  const number = data?.inv?.invoice_number ?? data?.inv?.number ?? 'invoice'
  doc.save(`INV-${number}.pdf`)
}

// ── Credit note ──────────────────────────────────────────────────────────────
// note: a credit_notes row (credit_number or number, issue_date, reason, status,
// subtotal, tax_amount, total, refund_status, refund_due, amount_allocated,
// refunded_amount, refunded_at, refund_method, cancelled_at). lines: its
// credit_note_lines. invoice: the invoice it credits (invoice_number or number,
// issue_date). allocations (optional): where its credit was applied, as
// credit_allocations rows or the public page's rows, each { invoice_number or
// number or invoice: { invoice_number }, amount, allocated_on, removed_at };
// removed ones are left out. Each prints as "Applied to invoice INV-1050", then
// any refund and the credit left. Without them, amount_allocated still prints
// as one row. The rest is the same as buildInvoiceDoc, and fmt should format
// in the note's currency.
export async function buildCreditNoteDoc({ note = {}, lines = [], invoice = {}, seller = {}, billTo = {}, allocations = [], fmt, taxLabel = 'Tax', dateLocale = 'en-US' } = {}) {
  const money = moneyFn(fmt)
  const ctx = startDoc(seller)
  const { doc, M } = ctx
  const label = creditNoteLabel(note.credit_number ?? note.number) || 'Credit note'
  const invNumber = invoice?.invoice_number ?? invoice?.number ?? note.invoice_number
  const invLabel = invNumber == null || invNumber === '' ? '' : `INV-${invNumber}`
  const cancelled = note.status === 'cancelled'

  // The status in the words the screens show (creditNoteStatusLabel: "£224.00
  // to use", "Used on INV-1050"), coloured by its kind: credit to use in
  // amber, used and refunded in green. A note that only reduced its own
  // invoice has none; the Invoice line above already names it.
  const kind = creditNoteStatusKind(note)
  const words = creditNoteStatusLabel(note, {
    invoiceNumber: invNumber,
    usedOn: (allocations || []).filter((a) => a && !a.removed_at && Number(a.amount) > 0)
      .map((a) => ({ invoice_number: a.invoice_number ?? a.number ?? a.invoice?.invoice_number })),
    money,
  }).toUpperCase()
  const pill = cancelled ? { t: 'CANCELLED', bg: [254, 226, 226], fg: [153, 27, 27] }
    : ['Available', 'Part used'].includes(kind) ? { t: words, short: kind === 'Available' ? 'CREDIT TO USE' : 'PART USED', bg: [254, 243, 199], fg: [146, 64, 14] }
      : ['Used', 'Refunded'].includes(kind) ? { t: words, short: kind.toUpperCase(), bg: [209, 250, 229], fg: [6, 95, 70] }
        : null
  await drawHeader(ctx, {
    seller, title: 'CREDIT NOTE', fallbackName: 'Credit note', pill,
    meta: [
      ['Credit note', label],
      invLabel ? ['Invoice', invLabel] : null,
      ['Issued', fmtDate(note.issue_date, dateLocale)],
    ],
  })
  drawParties(ctx, { billTo, label: 'CUSTOMER' })

  // Say up front which invoice this reduces and why, before any figures.
  if (invLabel) {
    const issued = invoice?.issue_date ? `, issued ${fmtDate(invoice.issue_date, dateLocale)}` : ''
    doc.setFont('helvetica', 'bold').setFontSize(10).setTextColor(40, 40, 40)
    doc.text(`Credit for invoice ${invLabel}${issued}`, M, ctx.y + 6)
    ctx.y += 24
  }
  drawBlock(ctx, 'REASON', note.reason)
  drawLines(ctx, { lines, taxLabel, money })

  // The stored figures are the ones the database issued; the lines are only a
  // fallback for a note passed in without them.
  const sums = creditTotals(lines)
  const [ar, ag, ab] = ctx.accent
  const rows = [
    ['Subtotal', note.subtotal ?? sums.subtotal],
    [taxLabel, note.tax_amount ?? sums.tax_amount],
    ['Total credited', note.total ?? sums.total, { bold: true, color: [ar, ag, ab], rule: true }],
  ]
  // Money the note hands back: applied to invoices, refunded, and what is left.
  if (!cancelled && ['owed', 'allocated', 'refunded'].includes(note.refund_status)) {
    const use = creditUse(note)
    const applied = (allocations || []).filter((a) => a && !a.removed_at && Number(a.amount) > 0)
    if (applied.length) {
      for (const a of applied) {
        const n = a.invoice_number ?? a.number ?? a.invoice?.invoice_number
        rows.push([n == null || n === '' ? 'Applied to another invoice' : `Applied to invoice INV-${n}`, a.amount,
          { note: a.allocated_on ? `On ${fmtDate(a.allocated_on, dateLocale)}` : null }])
      }
    } else if (use.used > 0) {
      rows.push(['Applied to other invoices', use.used])
    }
    if (use.refunded > 0) {
      const how = [note.refund_method, fmtDate(note.refunded_at, dateLocale)].filter(Boolean).join(', ')
      rows.push(['Refunded', use.refunded, { color: [6, 120, 70], note: how || null }])
    }
    if (use.left > 0 && !use.used && !use.refunded) {
      rows.push(['Credit available', use.left, { color: [146, 64, 14], note: 'Can be refunded or used on another invoice' }])
    } else if (use.left > 0 || use.used > 0) {
      rows.push(['Credit left', use.left, { bold: use.left > 0, color: use.left > 0 ? [146, 64, 14] : undefined }])
    }
  }
  drawTotals(ctx, rows, money)

  if (cancelled) {
    const on = note.cancelled_at ? ` on ${fmtDate(note.cancelled_at, dateLocale)}` : ''
    drawBlock(ctx, 'CANCELLED', `This credit note was cancelled${on}. It no longer reduces the invoice.`)
  }
  drawFooter(ctx, seller, label)
  return doc
}

/**
 * Builds the credit note PDF and saves it as CN-1001.pdf. Takes the same
 * object as buildCreditNoteDoc and resolves to the jsPDF doc.
 */
export async function creditNotePdf(data) {
  const doc = await buildCreditNoteDoc(data)
  const label = creditNoteLabel(data?.note?.credit_number ?? data?.note?.number) || 'credit-note'
  doc.save(`${label}.pdf`)
  return doc
}
