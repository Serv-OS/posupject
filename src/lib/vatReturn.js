// Pure VAT-reclaim aggregation for a VAT period (UK_VAT deployments).
// Preparation aid only — NOT a filed return. Input VAT is only treated as reclaimable
// when the category allows it AND a valid VAT invoice is held; otherwise it's flagged
// so it can be chased, never silently included or dropped. Unit-tested.
import { round2 } from './money.js';

// Classify one record (bill or expense) for reclaim.
export function classifyVat(item = {}) {
  const vat = Number(item.tax_amount || 0);
  const reclaimAmt = item.vat_reclaim_amount != null && item.vat_reclaim_amount !== ''
    ? Number(item.vat_reclaim_amount) : vat;                 // partial/blocked input VAT override
  const wantsReclaim = !!item.vat_reclaimable && vat > 0;    // category/record marked reclaimable
  const hasEvidence = !!item.has_vat_invoice;                // a valid VAT invoice is held
  return {
    vat, reclaimAmt,
    reclaimable: wantsReclaim && hasEvidence && reclaimAmt > 0,
    flaggedMissingInvoice: wantsReclaim && !hasEvidence,     // would reclaim, but no valid VAT invoice yet
  };
}

// Aggregate a reclaim summary from records already filtered to the VAT period.
export function computeVatReturn(items = []) {
  let reclaimable = 0, flaggedVat = 0;
  const byCategory = {}, bySupplier = {};
  const flagged = [];
  for (const it of items) {
    const c = classifyVat(it);
    if (c.reclaimable) {
      reclaimable = round2(reclaimable + c.reclaimAmt);
      const ck = it.category || 'Uncategorised'; byCategory[ck] = round2((byCategory[ck] || 0) + c.reclaimAmt);
      const sk = it.supplier || it.source || '—'; bySupplier[sk] = round2((bySupplier[sk] || 0) + c.reclaimAmt);
    } else if (c.flaggedMissingInvoice) {
      flaggedVat = round2(flaggedVat + c.vat);
      flagged.push(it);
    }
  }
  // box4 = VAT reclaimed on purchases (the figure that maps to the VAT-return Box 4).
  return { box4: reclaimable, reclaimable, flaggedVat, flaggedCount: flagged.length, flagged, byCategory, bySupplier, count: items.length };
}

const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// MTD-handoff CSV: one row per record + the reclaim breakdown. UTF-8 BOM for Excel,
// '\t' prefix on any value that looks like a formula (CSV-injection guard).
export function vatReturnCsv(items = [], fromDate, toDate) {
  const safe = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? "'" + s : s; };
  const head = ['Source', 'Ref', 'Date', 'Supplier', 'Category', 'Net', 'VAT', 'Reclaimable VAT', 'Valid VAT invoice', 'Status'];
  const rows = items.map(it => {
    const c = classifyVat(it);
    return [it.source, it.ref, it.date, safe(it.supplier || ''), safe(it.category || ''), it.net ?? '', it.vat,
      c.reclaimable ? c.reclaimAmt : 0, it.has_vat_invoice ? 'Y' : 'N',
      c.reclaimable ? 'reclaimable' : c.flaggedMissingInvoice ? 'MISSING VAT INVOICE' : 'not reclaimable'];
  });
  const meta = [`VAT period`, fromDate || '', toDate || ''];
  return '﻿' + [meta, [], head, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
}
