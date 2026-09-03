import { describe, it, expect, beforeEach } from 'vitest';
import { runOrQueue, pending, flush, remove } from './offlineQueue.js';

// A tiny localStorage + navigator so the queue can run outside a browser.
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } };
globalThis.window = { dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true, writable: true });

function fakeSupabase(log, fail) {
  const chain = (res) => ({ eq() { return this; }, then(r) { return Promise.resolve(res).then(r); } });
  return { from: (table) => ({
    insert: (values) => { log.push(['insert', table, values]); return Promise.resolve(fail ? { error: fail } : { error: null }); },
    update: (values) => { log.push(['update', table, values]); return chain(fail ? { error: fail } : { error: null }); },
    delete: () => { log.push(['delete', table]); return chain({ error: null }); },
  }) };
}

describe('offlineQueue', () => {
  beforeEach(() => { delete store['offline.queue.v1']; navigator.onLine = true; });

  it('writes straight through when online', async () => {
    const log = [];
    const r = await runOrQueue(fakeSupabase(log), 'Note', { table: 'crm_activities', kind: 'insert', values: { body: 'hi' } });
    expect(r.queued).toBe(false);
    expect(log).toEqual([['insert', 'crm_activities', { body: 'hi' }]]);
    expect(pending()).toHaveLength(0);
  });

  it('queues when offline and sends in order on flush', async () => {
    navigator.onLine = false;
    const log = [];
    await runOrQueue(fakeSupabase(log), 'Note on #1042', { table: 'crm_activities', kind: 'insert', values: { body: 'a' } });
    await runOrQueue(fakeSupabase(log), '45m logged', { table: 'time_entries', kind: 'insert', values: { duration_seconds: 2700 } });
    expect(log).toHaveLength(0);
    expect(pending().map(p => p.label)).toEqual(['Note on #1042', '45m logged']);
    navigator.onLine = true;
    const sent = await flush(fakeSupabase(log));
    expect(sent).toBe(2);
    expect(log.map(l => l[1])).toEqual(['crm_activities', 'time_entries']);
    expect(pending()).toHaveLength(0);
  });

  it('a network-looking error queues instead of failing', async () => {
    const log = [];
    const r = await runOrQueue(fakeSupabase(log, new Error('TypeError: Failed to fetch')), 'Status', { table: 'tasks', kind: 'update', values: { status: 'done' }, match: { id: 't1' } });
    expect(r.queued).toBe(true);
    expect(pending()).toHaveLength(1);
  });

  it('a real error stays in the queue, marked, and can be removed', async () => {
    navigator.onLine = false;
    await runOrQueue(fakeSupabase([]), 'Bad', { table: 'tasks', kind: 'update', values: {}, match: { id: 'x' } });
    navigator.onLine = true;
    await flush(fakeSupabase([], new Error('permission denied for table tasks')));
    expect(pending()[0].error).toMatch(/permission/);
    remove(pending()[0].id);
    expect(pending()).toHaveLength(0);
  });
});
