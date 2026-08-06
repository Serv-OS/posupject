// Deleting a bill.
//
// Only DRAFTS can be deleted. Once a bill is to_pay/paid it is part of the
// payables and VAT record, so the way to retire it is to void it — that keeps
// the bill number and the history. A draft has never counted towards anything,
// so removing it outright is safe, and it is the only way to clear a mis-keyed
// or duplicate entry out of the list.
//
// The supabase client is passed in rather than imported, so this module stays
// side-effect free and unit-testable (billOps.test.js) like the other finance
// helpers.

export const isBillDeletable = (bill) => bill?.status === 'draft';

export function canDeleteBill(bill, profile) {
  if (!isBillDeletable(bill)) return false;
  return profile?.role === 'owner' || profile?.role === 'editor';
}

/** Why a bill can't be deleted, for the UI to explain. Null when it can. */
export function deleteBlockedReason(bill, profile) {
  if (canDeleteBill(bill, profile)) return null;
  if (!(profile?.role === 'owner' || profile?.role === 'editor')) return 'Only editors and owners can delete bills.';
  if (bill?.status === 'void') return 'This bill is void — voided bills stay on record for the audit trail.';
  return 'Only draft bills can be deleted. Set the status to Void to retire a bill that has already been raised.';
}

/** The name shown in the confirm prompt, matching how the list labels a bill. */
export function billLabel(bill, supplierName) {
  const name = supplierName || bill?.supplier?.name || bill?.company?.name || bill?.description;
  return `BILL-${bill?.bill_number}${name ? ` — ${name}` : ''}`;
}

/**
 * Delete a draft bill and everything hanging off it.
 *
 * bill_line_items cascade in the database. Attachments do not — they are a
 * generic subject_type/subject_id table plus objects in a private bucket, so
 * both are cleared here. A bank transaction matched to this bill is released
 * back to the unreconciled list rather than left pointing at a missing row.
 *
 * The status is re-read from the database first (the row a list is holding can
 * be stale) and asserted again in the DELETE, so a concurrent "mark paid" wins
 * instead of losing a real payable.
 *
 * @param db      supabase client
 * @param billId  uuid
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function deleteBill(db, billId) {
  if (!billId) return { ok: false, error: 'No bill given.' };

  const { data: bill, error: readErr } = await db
    .from('bills').select('id, status').eq('id', billId).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!bill) return { ok: false, error: 'That bill no longer exists.' };
  if (!isBillDeletable(bill)) {
    return { ok: false, error: 'Only draft bills can be deleted — this one is no longer a draft.' };
  }

  // Attachments: storage objects first, then the rows. A failed file removal
  // leaves an orphan blob, not a broken record, so it is not worth aborting on.
  const { data: atts } = await db
    .from('attachments').select('id, file_path').eq('subject_type', 'bill').eq('subject_id', billId);
  const paths = (atts || []).map(a => a.file_path).filter(Boolean);
  if (paths.length) await db.storage.from('attachments').remove(paths);
  if ((atts || []).length) {
    await db.from('attachments').delete().eq('subject_type', 'bill').eq('subject_id', billId);
  }

  // Release any bank transaction matched to this bill.
  await db.from('bank_transactions')
    .update({ reconciled: false, matched_type: null, matched_id: null })
    .eq('matched_type', 'bill').eq('matched_id', billId);

  const { error, count } = await db
    .from('bills').delete({ count: 'exact' }).eq('id', billId).eq('status', 'draft');
  if (error) return { ok: false, error: error.message };
  if (!count) return { ok: false, error: 'The bill changed while deleting — it is no longer a draft.' };
  return { ok: true };
}
