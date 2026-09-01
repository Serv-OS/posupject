// "Give me this list as a PDF" — whatever list, however it is filtered.
//
// The point is that it prints WHAT YOU ARE LOOKING AT: the same rows, in the
// same order, with the filters you applied written on the page. A PDF that
// quietly exported everything would be worse than none, because you would not
// notice until someone acted on it.
//
// jsPDF is lazy-loaded (it is ~200KB) so it stays out of the main bundle,
// matching how invoicePdf.js already does it.

const fmtWhen = () => new Date().toLocaleString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

/**
 * @param {object}   opts
 * @param {string}   opts.title      e.g. "Support tickets"
 * @param {string[]} opts.columns    header row
 * @param {Array[]}  opts.rows       cell values, already formatted for reading
 * @param {string[]} [opts.filters]  human-readable filter descriptions
 * @param {string}   [opts.filename]
 * @param {string}   [opts.accent]   brand hex
 * @param {string}   [opts.footNote]
 */
export async function downloadListPdf({
  title, columns, rows, filters = [], filename, accent = '#15C26A', footNote,
}) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'),
  ]);

  // Landscape once a table gets wide, or columns collapse into unreadable slivers.
  const landscape = columns.length > 6;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(accent || '');
  const rgb = m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [21, 194, 106];

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(20, 20, 20);
  doc.text(title, 40, 46);

  // The filters are part of the document, not decoration: without them a reader
  // cannot tell a filtered list from a complete one.
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110, 110, 110);
  const sub = [`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`, ...filters].join('  ·  ');
  doc.text(sub, 40, 62);
  doc.text(fmtWhen(), pageW - 40, 62, { align: 'right' });

  autoTable(doc, {
    head: [columns],
    body: rows.map(r => r.map(c => (c === null || c === undefined ? '' : String(c)))),
    startY: 76,
    margin: { left: 40, right: 40, bottom: 46 },
    styles: { fontSize: 8.5, cellPadding: 5, overflow: 'linebreak', textColor: [35, 35, 35] },
    headStyles: { fillColor: rgb, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: [246, 248, 246] },
    // Page numbers are added in didDrawPage, but the total is only known at the
    // end, so the count is written in a second pass below.
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(8); doc.setTextColor(150, 150, 150);
      if (footNote) doc.text(footNote, 40, h - 24);
    },
  });

  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(150, 150, 150);
    doc.text(`Page ${i} of ${pages}`,
      doc.internal.pageSize.getWidth() - 40, doc.internal.pageSize.getHeight() - 24, { align: 'right' });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(filename || `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stamp}.pdf`);
}
