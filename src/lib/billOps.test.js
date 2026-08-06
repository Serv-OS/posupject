import { describe, it, expect } from 'vitest';
import { isBillDeletable, canDeleteBill, deleteBlockedReason, billLabel, deleteBill } from './billOps.js';

const owner = { role: 'owner' };
const editor = { role: 'editor' };
const viewer = { role: 'viewer' };

describe('isBillDeletable', () => {
  it('is true only for drafts', () => {
    expect(isBillDeletable({ status: 'draft' })).toBe(true);
    for (const status of ['to_pay', 'partially_paid', 'paid', 'void']) {
      expect(isBillDeletable({ status })).toBe(false);
    }
  });
  it('handles a missing bill', () => {
    expect(isBillDeletable(null)).toBe(false);
    expect(isBillDeletable({})).toBe(false);
  });
});

describe('canDeleteBill', () => {
  it('lets editors and owners delete a draft', () => {
    expect(canDeleteBill({ status: 'draft' }, owner)).toBe(true);
    expect(canDeleteBill({ status: 'draft' }, editor)).toBe(true);
  });
  it('refuses read-only roles', () => {
    expect(canDeleteBill({ status: 'draft' }, viewer)).toBe(false);
    expect(canDeleteBill({ status: 'draft' }, null)).toBe(false);
  });
  it('refuses a bill that has been raised, whoever is asking', () => {
    expect(canDeleteBill({ status: 'to_pay' }, owner)).toBe(false);
    expect(canDeleteBill({ status: 'paid' }, owner)).toBe(false);
    expect(canDeleteBill({ status: 'void' }, owner)).toBe(false);   // void stays on record
  });
});

describe('deleteBlockedReason', () => {
  it('is null when the delete is allowed', () => {
    expect(deleteBlockedReason({ status: 'draft' }, owner)).toBeNull();
  });
  it('blames the role before the status', () => {
    expect(deleteBlockedReason({ status: 'draft' }, viewer)).toMatch(/editors and owners/i);
  });
  it('explains void separately from other raised bills', () => {
    expect(deleteBlockedReason({ status: 'void' }, owner)).toMatch(/audit trail/i);
    expect(deleteBlockedReason({ status: 'to_pay' }, owner)).toMatch(/Only draft bills/i);
  });
});

describe('billLabel', () => {
  it('prefers the supplier name passed in', () => {
    expect(billLabel({ bill_number: 1042, description: 'Rent' }, 'Acme Ltd')).toBe('BILL-1042 — Acme Ltd');
  });
  it('falls back through joined supplier, company, then description', () => {
    expect(billLabel({ bill_number: 7, supplier: { name: 'Sup' }, company: { name: 'Co' } })).toBe('BILL-7 — Sup');
    expect(billLabel({ bill_number: 8, company: { name: 'Co' } })).toBe('BILL-8 — Co');
    expect(billLabel({ bill_number: 9, description: 'July power' })).toBe('BILL-9 — July power');
  });
  it('copes with a bill that has no name at all', () => {
    expect(billLabel({ bill_number: 10 })).toBe('BILL-10');
  });
});

// ---------------------------------------------------------------------------
// A minimal stand-in for the supabase client: enough of the chainable builder
// to record what deleteBill actually asks the database to do.
// ---------------------------------------------------------------------------
function fakeDb({ bill = { id: 'b1', status: 'draft' }, readErr = null, attachments = [],
                  deleteCount = 1, deleteErr = null } = {}) {
  const calls = [];
  const removed = [];

  const builder = (table, verb, payload) => {
    const rec = { table, verb, payload, filters: [] };
    calls.push(rec);
    const result =
      verb === 'select' && table === 'bills' ? { data: bill, error: readErr } :
      verb === 'select' && table === 'attachments' ? { data: attachments, error: null } :
      verb === 'delete' && table === 'bills' ? { error: deleteErr, count: deleteErr ? null : deleteCount } :
      { error: null, count: null };
    const chain = {
      eq: (col, val) => { rec.filters.push([col, val]); return chain; },
      maybeSingle: () => Promise.resolve(result),
      then: (res, rej) => Promise.resolve(result).then(res, rej),
    };
    return chain;
  };

  return {
    calls, removed,
    from: (table) => ({
      select: (cols) => builder(table, 'select', cols),
      delete: (opts) => builder(table, 'delete', opts),
      update: (patch) => builder(table, 'update', patch),
    }),
    storage: { from: () => ({ remove: (paths) => { removed.push(...paths); return Promise.resolve({ error: null }); } }) },
  };
}

const find = (db, table, verb) => db.calls.find(c => c.table === table && c.verb === verb);

describe('deleteBill', () => {
  it('deletes a draft, guarding the status in the DELETE itself', async () => {
    const db = fakeDb();
    expect(await deleteBill(db, 'b1')).toEqual({ ok: true });
    const del = find(db, 'bills', 'delete');
    expect(del.filters).toEqual([['id', 'b1'], ['status', 'draft']]);
    expect(del.payload).toEqual({ count: 'exact' });
  });

  it('refuses anything that is no longer a draft, without touching the row', async () => {
    for (const status of ['to_pay', 'partially_paid', 'paid', 'void']) {
      const db = fakeDb({ bill: { id: 'b1', status } });
      const r = await deleteBill(db, 'b1');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/draft/i);
      expect(find(db, 'bills', 'delete')).toBeUndefined();
    }
  });

  it('re-reads the status rather than trusting the caller', async () => {
    // The UI thinks it is a draft; the database says it has been raised.
    const db = fakeDb({ bill: { id: 'b1', status: 'paid' } });
    expect((await deleteBill(db, 'b1')).ok).toBe(false);
    expect(find(db, 'bills', 'select')).toBeTruthy();
  });

  it('clears attachment files and rows', async () => {
    const db = fakeDb({ attachments: [{ id: 'a1', file_path: 'bill/b1/one.pdf' }, { id: 'a2', file_path: 'bill/b1/two.png' }] });
    expect(await deleteBill(db, 'b1')).toEqual({ ok: true });
    expect(db.removed).toEqual(['bill/b1/one.pdf', 'bill/b1/two.png']);
    expect(find(db, 'attachments', 'delete').filters).toEqual([['subject_type', 'bill'], ['subject_id', 'b1']]);
  });

  it('skips attachment work when there are none', async () => {
    const db = fakeDb({ attachments: [] });
    await deleteBill(db, 'b1');
    expect(db.removed).toEqual([]);
    expect(find(db, 'attachments', 'delete')).toBeUndefined();
  });

  it('tolerates a link attachment with no stored file', async () => {
    const db = fakeDb({ attachments: [{ id: 'a1', file_path: null }] });
    expect(await deleteBill(db, 'b1')).toEqual({ ok: true });
    expect(db.removed).toEqual([]);                       // nothing to remove from storage…
    expect(find(db, 'attachments', 'delete')).toBeTruthy(); // …but the row still goes
  });

  it('releases a matched bank transaction back to unreconciled', async () => {
    const db = fakeDb();
    await deleteBill(db, 'b1');
    const upd = find(db, 'bank_transactions', 'update');
    expect(upd.payload).toEqual({ reconciled: false, matched_type: null, matched_id: null });
    expect(upd.filters).toEqual([['matched_type', 'bill'], ['matched_id', 'b1']]);
  });

  it('reports a bill that has already gone', async () => {
    const db = fakeDb({ bill: null });
    expect(await deleteBill(db, 'b1')).toEqual({ ok: false, error: 'That bill no longer exists.' });
  });

  it('surfaces a read error', async () => {
    const db = fakeDb({ readErr: { message: 'boom' } });
    expect(await deleteBill(db, 'b1')).toEqual({ ok: false, error: 'boom' });
  });

  it('surfaces a delete error', async () => {
    const db = fakeDb({ deleteErr: { message: 'permission denied' } });
    expect(await deleteBill(db, 'b1')).toEqual({ ok: false, error: 'permission denied' });
  });

  it('reports a lost race when the guarded delete matches nothing', async () => {
    const db = fakeDb({ deleteCount: 0 });
    const r = await deleteBill(db, 'b1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no longer a draft/i);
  });

  it('rejects a missing id', async () => {
    const db = fakeDb();
    expect(await deleteBill(db, null)).toEqual({ ok: false, error: 'No bill given.' });
    expect(db.calls).toEqual([]);
  });
});
