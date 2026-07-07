// MIME/UTF-8 helpers for email. Fixes mojibake (£, —, é …) in both directions:
//  - inbound: Gmail bodies are base64url of UTF-8 bytes; atob() alone yields a binary
//    string, so multibyte chars mangle. utf8FromB64Url decodes bytes as UTF-8.
//  - inbound headers: non-ASCII subjects/names arrive RFC-2047 encoded (=?UTF-8?B?…?=);
//    decodeMimeWords turns them back into text.
//  - outbound: header values with non-ASCII MUST be RFC-2047 encoded or clients read them
//    as Latin-1 and mangle them; encodeMimeWord does that.

// base64url (UTF-8) -> string
export function utf8FromB64Url(data: string): string {
  const bin = atob(String(data || "").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// Encode a header value as an RFC-2047 encoded-word iff it has non-ASCII chars.
export function encodeMimeWord(s: string): string {
  const str = s ?? "";
  if (/^[\x00-\x7F]*$/.test(str)) return str; // pure ASCII -> leave as-is
  const bytes = new TextEncoder().encode(str);
  let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

// Decode RFC-2047 encoded-words (=?charset?B/Q?text?=) in a header value.
export function decodeMimeWords(s: string): string {
  const str = s ?? "";
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    try {
      let bytes: Uint8Array;
      if (enc.toUpperCase() === "B") {
        const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
        bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else { // Q-encoding
        const q = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x: string, h: string) => String.fromCharCode(parseInt(h, 16)));
        bytes = Uint8Array.from(q, (c) => c.charCodeAt(0));
      }
      const cs = /utf-?8/i.test(charset) ? "utf-8" : String(charset).toLowerCase();
      return new TextDecoder(cs).decode(bytes);
    } catch {
      return _m; // leave the raw encoded-word if we can't decode it
    }
  });
}
