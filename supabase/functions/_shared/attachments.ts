// Shared attachment helpers for support tickets.
//  - inbound  (gmail-check / ms-check): store email attachments against the ticket
//  - outbound (gmail-send / ms-send): pull stored files to attach to a reply and
//    record them against the new activity.
// Files live in the private `attachments` storage bucket; metadata rows live in
// the `attachments` table (subject_type='ticket'). Keyed to the activity so the
// UI can show which message an image arrived on.

const BUCKET = "attachments";

// Chunked base64 so large files don't blow the argument limit of
// String.fromCharCode / btoa.
export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob((b64 || "").replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Gmail returns attachment data base64url-encoded.
export function b64urlToBytes(s: string): Uint8Array {
  return b64ToBytes((s || "").replace(/-/g, "+").replace(/_/g, "/"));
}

const safeName = (n: string) => (n || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);

// Store one inbound/outbound attachment: upload bytes to the bucket + insert the
// metadata row (linked to the ticket and, when known, the activity).
export async function storeAttachment(supabase: any, o: {
  ticketId: string; activityId?: string | null; name: string;
  mime?: string | null; bytes: Uint8Array; source: string; uploadedBy?: string | null;
}): Promise<boolean> {
  if (!o.ticketId || !o.bytes?.length) return false;
  const path = `ticket/${o.ticketId}/${crypto.randomUUID()}-${safeName(o.name)}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, o.bytes, {
    contentType: o.mime || "application/octet-stream", upsert: false,
  });
  if (upErr) { console.error("attachment upload failed:", upErr.message); return false; }
  const { error: insErr } = await supabase.from("attachments").insert({
    subject_type: "ticket", subject_id: o.ticketId, activity_id: o.activityId || null,
    file_name: o.name || "file", file_path: path, mime_type: o.mime || null,
    size_bytes: o.bytes.length, source: o.source, uploaded_by: o.uploadedBy || null,
  });
  if (insErr) { console.error("attachment row insert failed:", insErr.message); return false; }
  return true;
}

// Download stored files (by bucket path) so an outbound reply can attach them.
export async function loadAttachmentsForSend(
  supabase: any,
  items: { path: string; name?: string; type?: string }[],
): Promise<{ name: string; mime: string; bytes: Uint8Array; path: string }[]> {
  const out: { name: string; mime: string; bytes: Uint8Array; path: string }[] = [];
  for (const it of (items || [])) {
    if (!it?.path) continue;
    const { data, error } = await supabase.storage.from(BUCKET).download(it.path);
    if (error || !data) { console.error("attachment download failed:", it.path, error?.message); continue; }
    const bytes = new Uint8Array(await data.arrayBuffer());
    out.push({
      name: it.name || it.path.split("/").pop() || "file",
      mime: it.type || (data as { type?: string }).type || "application/octet-stream",
      bytes, path: it.path,
    });
  }
  return out;
}
