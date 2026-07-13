// Inbound emails arrive with the whole quoted reply chain + signatures appended
// ("On <date> … wrote:", Outlook "From:/Sent:/To:" blocks, etc.). cleanEmailBody
// returns just the sender's new message. It is:
//   • idempotent — a body with no quote markers comes back unchanged, so it's
//     safe to run on already-clean (outbound / older) bodies;
//   • non-destructive — the caller keeps the raw body and can reveal it.
// Cutting at the EARLIEST marker found means we never keep trailing quoted junk.
export function cleanEmailBody(raw) {
  if (!raw || typeof raw !== 'string') return raw || '';
  const t = raw.replace(/\r\n/g, '\n');
  const markers = [
    /-{2,}\s*Original Message\s*-{2,}/i,   // Outlook: -----Original Message-----
    /-{2,}\s*Forwarded message\s*-{2,}/i,  // forwarded blocks
    /\bFrom:\s.{0,160}?\bSent:\s/is,       // Outlook header block (From: … Sent:)
    /\bFrom:\s.{0,240}?\bSubject:\s/is,    // Outlook header block (From: … Subject:)
    /\bOn\b.{0,300}?\bwrote:/is,           // Gmail/Apple "On <date> … wrote:"
    /_{10,}/,                              // Outlook underscore divider line
    /\n\s*>{1,}\s?\S/,                     // first quoted (">") line
  ];
  let cut = t.length;
  for (const re of markers) {
    const m = t.match(re);
    if (m && m.index != null && m.index < cut) cut = m.index;
  }
  let head = t.slice(0, cut);
  head = head.replace(/\n--\s?\n[\s\S]*$/, '');   // drop a trailing RFC signature
  head = head.replace(/\n{3,}/g, '\n\n').trim();
  return head || t.trim();                        // never blank the message out
}

// True when cleaning removed a meaningful chunk — i.e. worth offering a
// "show quoted text" toggle rather than hiding nothing.
export function hasQuotedTail(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const full = raw.replace(/\r\n/g, '\n').trim();
  return cleanEmailBody(raw).length + 12 < full.length;
}
