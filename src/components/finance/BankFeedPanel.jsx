import { useEffect, useState, useCallback } from 'react';
// ui imported above
import { MobileTable, MobileSheet, SheetRow, Mono } from '../crm/ui.jsx';
import { supabase } from '../../lib/supabase';
import { Landmark, Plus, RefreshCw, X, AlertTriangle } from 'lucide-react';
import { fmtMoney } from '../../lib/money.js';
import { suggestMatch, suggestInvoice, invoiceBalance, applyRule, txnToBill, normalizePayee } from '../../lib/bankRecon.js';

const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';
const daysUntil = (d) => d ? Math.ceil((new Date(d + 'T00:00:00') - Date.now()) / 86400000) : null;

// A function's own error message: supabase-js only says "non-2xx status code"
// and keeps the body on error.context.
async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data, error: null };
  let detail = null;
  try { detail = (await error.context?.json())?.error; } catch { /* not json */ }
  return { data: detail ? { error: detail } : data, error: detail ? null : error };
}

export default function BankFeedPanel({ profile }) {
  const [pick, setPick] = useState(null); // phone (20): the transaction whose actions are open
  const [connections, setConnections] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [txns, setTxns] = useState([]);
  const [bills, setBills] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [rules, setRules] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [picker, setPicker] = useState(null);   // institutions list when connecting
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    const [c, a, t, b, e, r, s, cat, inv] = await Promise.all([
      supabase.from('bank_connections').select('*').order('created_at', { ascending: false }),
      supabase.from('bank_accounts').select('*'),
      supabase.from('bank_transactions').select('*').eq('reconciled', false).order('booking_date', { ascending: false }).limit(300),
      supabase.from('bills').select('id, total, currency, due_date, issue_date, supplier:inv_suppliers(name)').in('status', ['to_pay', 'partially_paid']),
      supabase.from('expenses').select('id, total, currency, expense_date, submitter:profiles!expenses_submitter_id_fkey(display_name)').eq('status', 'approved'),
      supabase.from('bank_match_rules').select('*'),
      supabase.from('inv_suppliers').select('id, name').order('name'),
      supabase.from('expense_categories').select('id, label').eq('active', true).order('sort'),
      // Open invoices, for matching money in. select('*') so a missing amount_allocated reads as none.
      supabase.from('invoices').select('*, company:companies(name)').in('status', ['sent', 'viewed']).order('invoice_number', { ascending: false }).limit(500),
    ]);
    setConnections(c.data || []); setAccounts(a.data || []);
    setTxns(t.data || []);
    setBills((b.data || []).map(x => ({ ...x, supplier_name: x.supplier?.name })));
    setExpenses((e.data || []).map(x => ({ ...x, supplier_name: x.submitter?.display_name })));
    setRules(r.data || []); setSuppliers(s.data || []); setCategories(cat.data || []);
    setInvoices((inv.data || []).map(x => ({ ...x, company_name: x.company?.name })).filter(x => invoiceBalance(x) > 0));
  }, []);
  useEffect(() => { load(); }, [load]);

  const connect = async () => {
    setBusy('institutions'); setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'institutions', country: 'gb' });
    setBusy('');
    if (error || data?.error) { setErr('Could not load banks — is the bank-connect function deployed + secrets set? ' + (error?.message || data?.error || '')); return; }
    setPicker(data.institutions || []);
  };
  const pickBank = async (inst) => {
    setBusy('init'); setErr(''); setPicker(null);
    const { data, error } = await invoke('bank-connect', { action: 'init', institution_id: inst.id, country: inst.country || 'GB' });
    setBusy('');
    if (error || data?.error) { setErr('Could not connect. ' + (error?.message || data?.error || '')); return; }
    if (data.link) { window.location.href = data.link; return; }   // hosted bank-consent flow (Open Banking providers)
    if (data.connected) { load(); return; }                         // Google Sheets: linked directly, no redirect
    setErr('Could not connect — unexpected response.');
  };
  const refresh = async (connId) => {
    setBusy('sync:' + connId); setErr('');
    const { data, error } = await invoke('bank-sync', { connection_id: connId });
    setBusy('');
    if (error || data?.error) { setErr('Sync failed. ' + (error?.message || data?.error || '')); return; }
    load();
  };

  const accountsFor = (connId) => accounts.filter(a => a.connection_id === connId);
  // A transaction shows its own currency, else its account's (both bank tables carry one); never a fixed £.
  const ccyOf = (t) => t.currency || accounts.find(a => a.id === t.account_id)?.currency || 'GBP';
  // Only suggest a bill/expense in the transaction's own currency: $50 is not £50, and a
  // cross-currency "Match" would book a $ payment against a £ document.
  const sameCcy = (t) => (r) => (r.currency || 'GBP') === ccyOf(t);
  const suggestFor = (t) => (Number(t.amount) > 0
    ? suggestInvoice(t, invoices.filter(sameCcy(t)))
    : suggestMatch(t, bills.filter(sameCcy(t)), expenses.filter(sameCcy(t))));
  const invLabel = (id) => { const i = invoices.find(x => x.id === id); return i ? `INV-${i.invoice_number}${i.company_name ? ` · ${i.company_name}` : ''}` : 'invoice'; };
  const sugLabel = (sg) => (sg.type === 'invoice' ? `Match ${invLabel(sg.id)}${sg.part ? ' (part)' : ''}` : `Match ${sg.type}`);

  // reconcile actions
  const markReconciled = (id, patch) => supabase.from('bank_transactions').update({ reconciled: true, ...patch }).eq('id', id);
  const matchTo = async (txn, type, id) => {
    if (type === 'invoice') {
      setErr('');
      const { data, error } = await invoke('bank-connect', { action: 'match_invoice', txn_id: txn.id, invoice_id: id });
      if (error || data?.error) setErr('Could not match: ' + (data?.error || error?.message || ''));
      load();
      return;
    }
    const paid = { status: 'paid', amount_paid: Math.abs(txn.amount), paid_at: txn.booking_date || txn.value_date, payment_method: 'bank', payment_reference: txn.dedup_key };
    await supabase.from(type === 'bill' ? 'bills' : 'expenses').update(paid).eq('id', id);
    await markReconciled(txn.id, { matched_type: type, matched_id: id });
    load();
  };
  const createBill = async (txn) => {
    const rule = applyRule(txn, rules);
    const bill = txnToBill(txn, { supplier_id: rule?.supplier_id || null, category_id: rule?.category_id || null, cost_context: rule?.cost_context || 'ongoing' });
    // the bill is in the transaction's currency (account fallback when the row itself has none)
    const { data: b } = await supabase.from('bills').insert({ ...bill, currency: ccyOf(txn), created_by: profile.id }).select('id').single();
    if (b) await markReconciled(txn.id, { matched_type: 'bill', matched_id: b.id, category_id: bill.category_id });
    load();
  };
  const ignore = async (txn) => { await markReconciled(txn.id, { matched_type: 'ignored' }); load(); };
  const activate = async (connId) => {
    setBusy('activate:' + connId); setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'activate', connection_id: connId });
    setBusy('');
    if (error || data?.error) { setErr('Could not finish connecting. ' + (data?.error || error?.message || '')); return; }
    if (data.waiting) { setErr('Monzo is still waiting for you to tap Allow in the Monzo app.'); return; }
    load();
  };
  const openInvoices = (t) => invoices.filter(sameCcy(t)).sort((a, b) => Math.abs(invoiceBalance(a) - t.amount) - Math.abs(invoiceBalance(b) - t.amount));

  return (
    <div className="h-full flex flex-col">
      <div className="lg:hidden flex-1 min-h-0 flex flex-col">
        <div className="px-[18px] pt-3 pb-2.5">
          <div className="font-display text-[23px] font-extrabold text-paper">Bank feed</div>
          <Mono className="!tracking-[.18em] uppercase">{txns.length} to reconcile</Mono>
        </div>
        <div className="flex-1 overflow-y-auto px-[14px] pb-[calc(70px+env(safe-area-inset-bottom))]">
          <MobileTable storageKey="bank.mobile" rows={txns} onRow={(t) => setPick(t)} empty="Nothing to reconcile — all caught up."
            columns={[
              { key: 'payee', label: 'Payee', pinned: true, render: (t) => t.payee || t.description || 'Payment' },
              { key: 'date', label: 'Date', render: (t) => fmtD(t.booking_date || t.value_date) },
              { key: 'amount', label: 'Amount', align: 'right', mono: true, render: (t) => fmtMoney(t.amount, ccyOf(t)) },
              { key: 'match', label: 'Suggested', render: (t) => { const sg = suggestFor(t); return sg ? (sg.type === 'invoice' ? invLabel(sg.id) : sg.type) : '—'; } },
              { key: 'rule', label: 'Rule', render: (t) => { const r = applyRule(t, rules); return r ? (categories.find(c => c.id === r.category_id)?.label || 'categorised') : '—'; } },
              { key: 'desc', label: 'Description', render: (t) => t.description || '—' },
            ]}
            card={(t) => { const sg = suggestFor(t); return { title: t.payee || t.description || 'Payment', amount: fmtMoney(t.amount, ccyOf(t)), chip: sg ? { text: sugLabel(sg), tone: 'primary' } : { text: 'Unmatched', tone: 'muted' }, meta: fmtD(t.booking_date || t.value_date) }; }} />
        </div>
        {pick && (
          <MobileSheet title={pick.payee || pick.description || 'Payment'} sub={`${fmtMoney(pick.amount, ccyOf(pick))} · ${fmtD(pick.booking_date || pick.value_date)}`} onClose={() => setPick(null)}>
            {(() => { const sg = suggestFor(pick); return sg && canWrite ? <SheetRow onClick={() => { matchTo(pick, sg.type, sg.id); setPick(null); }} sub="The suggested match">{sugLabel(sg)}</SheetRow> : null; })()}
            {canWrite && Number(pick.amount) > 0 && openInvoices(pick).slice(0, 6).map(i => (
              <SheetRow key={i.id} onClick={() => { matchTo(pick, 'invoice', i.id); setPick(null); }} sub={`${fmtMoney(invoiceBalance(i), i.currency)} owed`}>{`Pay INV-${i.invoice_number}${i.company_name ? ` · ${i.company_name}` : ''}`}</SheetRow>
            ))}
            {canWrite && Number(pick.amount) < 0 && <SheetRow onClick={() => { createBill(pick); setPick(null); }} sub="A paid bill with date, amount and payee filled in">Create bill</SheetRow>}
            {canWrite && <SheetRow tone="coral" onClick={() => { ignore(pick); setPick(null); }}>Ignore</SheetRow>}
          </MobileSheet>
        )}
      </div>
      <div className="hidden lg:flex px-6 py-5 border-b border-bdr items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Landmark size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Bank feed</div>
            <div className="text-xs text-muted">Match money in to invoices, and money out to bills and expenses</div>
          </div>
        </div>
        {canWrite && <button onClick={connect} disabled={busy === 'institutions'} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> {busy === 'institutions' ? 'Loading…' : 'Connect bank'}</button>}
      </div>

      <div className="hidden lg:block flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {err && <div className="glass-card rounded-2xl p-3 text-sm text-red-600 flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0" />{err}</div>}

          {/* Connections */}
          {connections.map(c => {
            const dleft = daysUntil(c.consent_expires_at);
            return (
              <div key={c.id} className="glass-card rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${c.status === 'LN' ? 'bg-emerald-500' : c.status === 'EX' || c.status === 'SUSPENDED' ? 'bg-red-500' : 'bg-amber-400'}`} />
                  <h3 className="text-[13px] font-bold text-paper">{c.institution_name || c.institution_id}</h3>
                  <span className="text-[10px] text-dim font-mono uppercase">{c.status}</span>
                  {dleft != null && c.status === 'LN' && <span className={`text-[10px] ${dleft <= 7 ? 'text-amber-600' : 'text-dim'}`}>· consent {dleft > 0 ? `expires in ${dleft}d` : 'EXPIRED — reconnect'}</span>}
                  {canWrite && c.status === 'SA' && <button onClick={() => activate(c.id)} disabled={busy === 'activate:' + c.id} className="ml-auto text-xs text-ember font-medium">{busy === 'activate:' + c.id ? 'Checking…' : "I've tapped Allow in Monzo"}</button>}
                  {c.status === 'EX' && <span className="ml-auto text-xs text-red-600">Access ended. Click Connect bank to reconnect.</span>}
                  {canWrite && c.status === 'LN' && <button onClick={() => refresh(c.id)} disabled={busy === 'sync:' + c.id} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium inline-flex items-center gap-1"><RefreshCw size={12} className={busy === 'sync:' + c.id ? 'animate-spin' : ''} /> Refresh</button>}
                </div>
                <div className="divide-y divide-bdr/60">
                  {accountsFor(c.id).length === 0 ? <div className="px-5 py-3 text-xs text-dim italic">{c.status === 'LN' ? 'No accounts yet — hit Refresh.' : 'Finish connecting at your bank.'}</div>
                    : accountsFor(c.id).map(a => (
                      <div key={a.id} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                        <div className="flex-1 min-w-0"><div className="text-paper truncate">{a.name || a.owner_name || a.iban || a.gc_account_id.slice(0, 8)}</div>
                          <div className="text-[10px] text-dim">{a.iban || ''}{a.last_synced_at ? ` · synced ${fmtD(a.last_synced_at.slice(0, 10))}` : ''}</div></div>
                        {a.balance != null && <div className="tabular-nums text-paper font-semibold">{fmtMoney(a.balance, a.currency)}</div>}
                      </div>
                    ))}
                </div>
              </div>
            );
          })}
          {connections.length === 0 && !err && <div className="glass-card rounded-2xl p-8 text-center text-dim text-sm italic">No bank connected yet. Click "Connect bank" to link Monzo.</div>}

          {/* Reconcile inbox */}
          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-bdr flex items-center gap-2">
              <h3 className="text-[13px] font-bold text-paper">To reconcile</h3>
              <span className="text-xs text-dim font-mono">({txns.length})</span>
            </div>
            <div className="divide-y divide-bdr/60">
              {txns.length === 0 ? <div className="px-5 py-8 text-center text-dim text-sm italic">Nothing to reconcile — all caught up.</div>
                : txns.map(t => {
                  const sug = suggestFor(t);
                  const rule = applyRule(t, rules);
                  return (
                    <div key={t.id} className="px-5 py-3 flex items-center gap-3 text-sm flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="text-paper font-medium truncate">{t.payee || t.description || 'Payment'}</div>
                        <div className="text-[10px] text-dim">{Number(t.amount) > 0 ? 'Money in · ' : ''}{t.status === 'pending' ? 'Pending · ' : ''}{fmtD(t.booking_date || t.value_date)}{t.description && t.description !== t.payee ? ` · ${t.description}` : ''}{rule ? ` · rule → ${categories.find(c => c.id === rule.category_id)?.label || 'categorised'}` : ''}</div>
                      </div>
                      <div className={`tabular-nums font-semibold shrink-0 ${Number(t.amount) > 0 ? 'text-emerald-600' : 'text-paper'}`}>{Number(t.amount) > 0 ? '+' : ''}{fmtMoney(t.amount, ccyOf(t))}</div>
                      {canWrite && <div className="flex items-center gap-1.5 shrink-0">
                        {sug && <button onClick={() => matchTo(t, sug.type, sug.id)} className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200">{sugLabel(sug)}</button>}
                        {Number(t.amount) > 0 ? (
                          <select value="" onChange={e => e.target.value && matchTo(t, 'invoice', e.target.value)} className="px-2 py-1 text-xs rounded-lg bg-card border border-bdr text-paper max-w-[190px]">
                            <option value="">Pay an invoice…</option>
                            {openInvoices(t).map(i => <option key={i.id} value={i.id}>INV-{i.invoice_number}{i.company_name ? ` · ${i.company_name}` : ''} · {fmtMoney(invoiceBalance(i), i.currency)}</option>)}
                          </select>
                        ) : <button onClick={() => createBill(t)} className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-ember/10 text-ember-deep hover:bg-ember/20">Create bill</button>}
                        <button onClick={() => ignore(t)} className="px-2.5 py-1 text-xs text-dim hover:text-paper">Ignore</button>
                      </div>}
                    </div>
                  );
                })}
            </div>
          </div>
          <div className="text-[11px] text-dim">"Create bill" makes a paid bill from the transaction (date, amount, payee pre‑filled). Money in can pay an invoice (it is booked as a bank payment on the invoice). Bank data is read only: no payment is ever made from here.</div>
        </div>
      </div>

      {picker && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setPicker(null)}>
          <div className="glass-card rounded-2xl w-full max-w-md max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card"><div className="text-base font-bold text-paper">Choose your bank</div><button onClick={() => setPicker(null)} className="text-muted hover:text-paper"><X size={18} /></button></div>
            <div className="p-3 space-y-1">
              {picker.length === 0 ? <div className="p-4 text-center text-dim text-sm">No banks returned.</div>
                : picker.map(i => (
                  <button key={i.id} onClick={() => pickBank(i)} className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-card text-left">
                    {i.logo && <img src={i.logo} alt="" className="w-7 h-7 rounded object-contain shrink-0" />}
                    <span className="text-sm text-paper">{i.name}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
