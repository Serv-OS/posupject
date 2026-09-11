// Recipient lists for outgoing email: parse, validate, and write bare addresses.
//
// MIRROR: src/lib/replyRecipients.js carries the same parsing rules for the
// screens (Deno cannot import from src/). Change both or neither.

const SEP = /[,;]/;

export const isValidEmail = (e: string) => /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]+$/.test(String(e || ""));

// Split on commas/semicolons that are not inside quotes or angle brackets.
function tokens(header: unknown): string[] {
  const text = String(Array.isArray(header) ? header.join(", ") : (header ?? "")).replace(/[\r\n]+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  let cur = "", quoted = false, angle = 0;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted && angle) angle--;
    if (SEP.test(ch) && !quoted && !angle) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

const addressOf = (token: string) => {
  const m = token.match(/<([^<>]+)>/);
  return (m ? m[1] : token).trim().replace(/^mailto:/i, "").toLowerCase();
};

export function parseAddressList(header: unknown): { name: string; email: string }[] {
  const seen = new Set<string>();
  const out: { name: string; email: string }[] = [];
  for (const t of tokens(header)) {
    const email = addressOf(t);
    if (!isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    const m = t.match(/<([^<>]+)>/);
    out.push({ name: m ? t.slice(0, m.index).trim().replace(/^"|"$/g, "").trim() : "", email });
  }
  return out;
}

// Anything typed that is not an address. The sender is told, rather than someone silently dropped.
export const invalidAddresses = (header: unknown): string[] => tokens(header).filter((t) => !isValidEmail(addressOf(t)));

// "a@x.com, b@y.com": names left out on purpose, so no display name can smuggle a header in.
export const headerList = (list: { email: string }[]) => list.map((a) => a.email).filter(isValidEmail).join(", ");

// The mailbox an address delivers to, for spotting our own: lower case, +tag dropped.
export const mailboxKey = (email: string): string => String(email || "").trim().toLowerCase().replace(/\+[^@]*@/, "@");
