import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { Landmark, Plus, RefreshCw, X, AlertTriangle, Search, Sparkles, Lock } from 'lucide-react';
import { fmtMoney as fmtCcy } from '../../lib/money.js';
import { suggestMatch, suggestInvoice, suggestPaidInvoice, invoiceBalance, applyRule, normalizePayee } from '../../lib/bankRecon.js';

// The bank feed (Monzo Business, live). Peter, 25 Nov 2026:
//  1. only people the owner allows see it (profiles.bank_feed_access)
//  2. Create bill opens the bill so the details can be finished
//  4. every match is searchable, and an AI suggests the likely match
//  5. money in with no invoice can raise one from here
//  6. a refund pairs with the payment it reverses
//  7. company card spend goes to the person who spent it, as an expense they
//     add the receipt to
// This CRM works in pounds AND dollars (UK Monzo, US Brex). Every line, account
// and document carries its currency; a line is only ever matched to a document
// in the same currency.

const fmtMoney = (n, c = 'GBP') => (Number(n) < 0 ? '-' + fmtCcy(-Number(n), c || 'GBP') : fmtCcy(n, c || 'GBP'));
const ccy = (x) => x?.currency || 'GBP';
const sameCcy = (t) => (d) => ccy(d) === ccy(t);
const fmtD = (d) => (d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '');
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
export const canSeeBank = (p) => p?.role === 'owner' || (p?.role === 'editor' && !!p?.bank_feed_access);

// A function's own error message: supabase-js only says "non-2xx status code"
// and keeps the body on error.context.
async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return { data, error: null };
  let detail = null;
  try { detail = (await error.context?.json())?.error; } catch { /* not json */ }
  return { data: detail ? { error: detail } : data, error: detail ? null : error };
}

const KIND_LABEL = {
  invoice: 'Pays an invoice', bill: 'Pays a bill', expense: 'Reimburses an expense', refund: 'Refund of another line',
  company_card: 'Company card spend', new_bill: 'Needs a bill', new_invoice: 'Needs an invoice', ignore: 'Nothing to book', none: 'Not sure',
};

export default function BankFeedPanel({ profile, onNavigate }) {
  const [connections, setConnections] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [txns, setTxns] = useState([]);
  const [done, setDone] = useState([]);
  const [bills, setBills] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [paidInvoices, setPaidInvoices] = useState([]);   // already marked paid, to link bank lines to
  const [rules, setRules] = useState([]);
  const [categories, setCategories] = useState([]);
  const [people, setPeople] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [picker, setPicker] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [dir, setDir] = useState('all');        // all | in | out
  const [q, setQ] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [matchFor, setMatchFor] = useState(null); // the line the Find match window is open for
  const [cardFor, setCardFor] = useState(null);   // the line being given to a person as card spend
  const [brexOpen, setBrexOpen] = useState(false); // Brex connects with a token pasted here
  const allowed = canSeeBank(profile);

  const load = useCallback(async () => {
    if (!allowed) return;
    const [c, a, t, d, b, e, inv, r, cat, ppl, co, pinv] = await Promise.all([
      supabase.from('bank_connections').select('*').order('created_at', { ascending: false }),
      supabase.from('bank_accounts').select('*'),
      supabase.from('bank_transactions').select('*').eq('reconciled', false).order('booking_date', { ascending: false }).limit(500),
      supabase.from('bank_transactions').select('*').eq('reconciled', true).order('booking_date', { ascending: false }).limit(150),
      supabase.from('bills').select('id, bill_number, total, amount_paid, currency, due_date, issue_date, description, supplier:inv_suppliers(name)').in('status', ['to_pay', 'partially_paid']),
      supabase.from('expenses').select('id, expense_number, total, currency, expense_date, description, paid_by, submitter:profiles!expenses_submitter_id_fkey(display_name)').eq('status', 'approved'),
      supabase.from('invoices').select('*, company:companies(name)').in('status', ['sent', 'viewed']).order('invoice_number', { ascending: false }).limit(500),
      supabase.from('bank_match_rules').select('*'),
      supabase.from('expense_categories').select('id, label').eq('active', true).order('sort'),
      supabase.from('profiles').select('id, display_name, role').in('role', ['owner', 'editor']).order('display_name'),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('invoices').select('id, invoice_number, total, amount_paid, currency, paid_at, due_date, issue_date, company:companies(name)').eq('status', 'paid').order('invoice_number', { ascending: false }).limit(1500),
    ]);
    setConnections(c.data || []); setAccounts(a.data || []);
    setTxns(t.data || []); setDone(d.data || []);
    setBills((b.data || []).map(x => ({ ...x, supplier_name: x.supplier?.name })));
    setExpenses((e.data || []).filter(x => x.paid_by !== 'company_card').map(x => ({ ...x, supplier_name: x.submitter?.display_name })));
    setInvoices((inv.data || []).map(x => ({ ...x, company_name: x.company?.name })).filter(x => invoiceBalance(x) > 0));
    setRules(r.data || []); setCategories(cat.data || []); setPeople(ppl.data || []); setCompanies(co.data || []);
    setPaidInvoices((pinv.data || []).map(x => ({ ...x, company_name: x.company?.name })));
  }, [allowed]);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setNote(m); setTimeout(() => setNote(''), 3500); };
  const fail = (m) => setErr(m);
  const nameOf = (id) => people.find(p => p.id === id)?.display_name || 'someone';
  const catOf = (id) => categories.find(c => c.id === id)?.label;

  // ── Connecting ────────────────────────────────────────────────────────────
  const connect = async () => {
    setBusy('institutions'); setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'institutions' });
    setBusy('');
    if (error || data?.error) { fail('Could not load banks. ' + (data?.error || error?.message || '')); return; }
    setPicker(data.institutions || []);
  };
  const pickBank = async (inst) => {
    setErr(''); setPicker(null);
    if (inst.token) { setBrexOpen(true); return; }
    setBusy('init');
    const { data, error } = await invoke('bank-connect', { action: 'init', institution_id: inst.id });
    setBusy('');
    if (error || data?.error) { fail('Could not connect. ' + (data?.error || error?.message || '')); return; }
    if (data.link) { window.location.href = data.link; return; }
    load();
  };
  const refresh = async (connId) => {
    setBusy('sync'); setErr('');
    const { data, error } = await invoke('bank-sync', { connection_id: connId });
    setBusy('');
    if (error || data?.error) { fail('Sync failed. ' + (data?.error || error?.message || '')); return; }
    const n = (data.results || []).reduce((s, r) => s + (r.synced || 0), 0);
    flash(`Synced ${n} lines${data.auto_booked > 0 ? `, ${data.auto_booked} booked by your rules` : ''}${data.ai?.checked ? `, AI checked ${data.ai.checked}` : ''}.`);
    load();
  };
  const activate = async (connId) => {
    setBusy('activate'); setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'activate', connection_id: connId });
    setBusy('');
    if (error || data?.error) { fail('Could not finish connecting. ' + (data?.error || error?.message || '')); return; }
    if (data.waiting) { fail('Monzo is still waiting for you to tap Allow in the Monzo app.'); return; }
    load();
  };
  const askAi = async (ids) => {
    setBusy('ai'); setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'ai_match', txn_ids: ids });
    setBusy('');
    if (error || data?.error) { fail('AI matching failed. ' + (data?.error || error?.message || '')); return; }
    flash(`AI checked ${data.checked} line${data.checked === 1 ? '' : 's'}.`);
    load();
  };

  // ── Booking ───────────────────────────────────────────────────────────────
  const reconcile = (id, patch) => supabase.from('bank_transactions').update({ reconciled: true, ...patch }).eq('id', id);

  const matchInvoice = async (txn, invoiceId) => {
    setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'match_invoice', txn_id: txn.id, invoice_id: invoiceId });
    if (error || data?.error) { fail('Could not match. ' + (data?.error || error?.message || '')); return; }
    flash(`Booked against INV-${data.result?.invoice_number ?? ''}.`);
    setMatchFor(null); load();
  };
  // Money in for an invoice already marked paid: link it, never pay it twice.
  const linkPaid = async (txn, id) => {
    const { error } = await reconcile(txn.id, { matched_type: 'invoice', matched_id: id });
    if (error) { fail(error.message); return; }
    const i = paidInvoices.find(x => x.id === id);
    flash(`Linked to INV-${i?.invoice_number ?? ''} (already paid, nothing recorded twice).`);
    setMatchFor(null); load();
  };
  const linkAllPaid = async () => {
    const pairs = [];
    const taken = new Set(linkedIds);
    for (const t of txns.filter(x => x.amount > 0)) {
      if (suggestInvoice(t, invoices.filter(sameCcy(t)))) continue;
      const sg = suggestPaidInvoice(t, paidInvoices.filter(sameCcy(t)), taken);
      if (sg?.named) { pairs.push([t, sg.id]); taken.add(sg.id); }
    }
    if (!pairs.length) { flash('Nothing to link.'); return; }
    setBusy('linkall');
    for (const [t, id] of pairs) await reconcile(t.id, { matched_type: 'invoice', matched_id: id });
    setBusy(''); flash(`Linked ${pairs.length} payment${pairs.length === 1 ? '' : 's'} to invoices already marked paid.`); load();
  };
  const matchDoc = async (txn, type, id) => {
    if (type === 'invoice_paid' || (type === 'invoice' && isPaidInv(id))) return linkPaid(txn, id);
    if (type === 'invoice') return matchInvoice(txn, id);
    const paid = { status: 'paid', amount_paid: Math.abs(txn.amount), paid_at: txn.booking_date, payment_method: 'bank', payment_reference: txn.dedup_key };
    const { error } = await supabase.from(type === 'bill' ? 'bills' : 'expenses').update(paid).eq('id', id);
    if (error) { fail(error.message); return; }
    await reconcile(txn.id, { matched_type: type, matched_id: id });
    setMatchFor(null); load();
  };
  const pairRefund = async (txn, other) => {
    if (!other) { fail('That line is no longer here. Refresh and try again.'); return; }
    if (Math.sign(Number(txn.amount)) === Math.sign(Number(other.amount))) { fail('A refund goes the other way: one line in, one line out.'); return; }
    await reconcile(txn.id, { matched_type: 'refund', pair_id: other.id });
    if (!other.reconciled) await reconcile(other.id, { matched_type: 'refund', pair_id: txn.id });
    else await supabase.from('bank_transactions').update({ pair_id: txn.id }).eq('id', other.id);
    flash('Paired as a refund.'); setMatchFor(null); load();
  };
  const ignore = async (txn) => { await reconcile(txn.id, { matched_type: 'ignored' }); load(); };
  const undo = async (t) => {
    if (!['ignored', 'refund'].includes(t.matched_type)) return;
    await supabase.from('bank_transactions').update({ reconciled: false, matched_type: null, matched_id: null, pair_id: null }).eq('id', t.id);
    if (t.matched_type === 'refund' && t.pair_id) {
      await supabase.from('bank_transactions').update({ reconciled: false, matched_type: null, pair_id: null }).eq('id', t.pair_id).eq('matched_type', 'refund');
    }
    load();
  };

  // 2: a paid bill with the line on it, then straight into the bill to finish it.
  const createBill = async (txn) => {
    const rule = applyRule(txn, rules);
    const gross = r2(Math.abs(txn.amount));
    const what = txn.payee || txn.description || 'Bank payment';
    const cat = rule?.category_id || (txn.ai_match?.kind === 'new_bill' ? txn.ai_match.category_id : null) || null;
    const { data: b, error } = await supabase.from('bills').insert({
      supplier_id: rule?.supplier_id || null, category_id: cat, cost_context: rule?.cost_context || 'ongoing',
      status: 'paid', description: what, currency: ccy(txn), issue_date: txn.booking_date,
      subtotal: gross, tax_amount: 0, total: gross, amounts_inclusive: true,
      amount_paid: gross, paid_at: txn.booking_date, payment_method: 'bank', payment_reference: txn.dedup_key, created_by: profile.id,
    }).select('id').single();
    if (error) { fail(error.message); return; }
    await supabase.from('bill_line_items').insert({ bill_id: b.id, name: what, description: txn.description && txn.description !== what ? txn.description : null, qty: 1, unit_price: gross, tax_rate: 0, category_id: cat, line_total: gross, sort: 0 });
    await reconcile(txn.id, { matched_type: 'bill', matched_id: b.id, category_id: cat });
    onNavigate?.('bill', b.id);
  };

  // 5: a draft invoice for the money that came in, opened to finish. The line
  // stays unmatched with the new invoice as its suggestion, so it is booked
  // with one click once the invoice is right.
  const createInvoice = async (txn) => {
    const gross = r2(txn.amount);
    const payer = normalizePayee(txn.payee);
    const co = payer ? companies.find(c => { const n = normalizePayee(c.name); return n && (n.includes(payer) || payer.includes(n)); }) : null;
    // UK invoices carry 20% VAT inside the payment; US ones have no VAT.
    const us = ccy(txn) === 'USD';
    const net = us ? gross : r2(gross / 1.2);
    const { data: inv, error } = await supabase.from('invoices').insert({
      status: 'draft', currency: ccy(txn), created_by: profile.id, company_id: co?.id || null, issue_date: txn.booking_date, due_date: txn.booking_date,
      notes: `Raised for a bank payment of ${fmtMoney(gross, ccy(txn))} on ${fmtD(txn.booking_date)} from ${txn.payee || 'unknown'}${txn.description ? ` (${txn.description})` : ''}.`,
    }).select('id').single();
    if (error) { fail(error.message); return; }
    await supabase.from('invoice_line_items').insert({ invoice_id: inv.id, name: txn.description || 'Services', description: null, qty: 1, unit_price: net, tax_rate: us ? 0 : 20, sort: 0 });
    await supabase.from('bank_transactions').update({ ai_match: { kind: 'invoice', target_id: inv.id, confidence: 1, reason: 'Raised from this payment. Finish and send the invoice, then match it here.' } }).eq('id', txn.id);
    onNavigate?.('invoice', inv.id);
  };

  // ── Suggestions ───────────────────────────────────────────────────────────
  // Invoices a bank line is already linked to (booked or linked), so a paid
  // invoice is only ever claimed once.
  const linkedIds = useMemo(() => new Set(done.filter(x => x.matched_type === 'invoice' && x.matched_id).map(x => x.matched_id)), [done]);
  const suggestFor = (t) => (Number(t.amount) > 0
    ? suggestInvoice(t, invoices.filter(sameCcy(t))) || suggestPaidInvoice(t, paidInvoices.filter(sameCcy(t)), linkedIds)
    : suggestMatch(t, bills.filter(sameCcy(t)), expenses.filter(sameCcy(t))));
  const isPaidInv = (id) => paidInvoices.some(x => x.id === id);
  const docLabel = (type, id) => {
    if (type === 'invoice' || type === 'invoice_paid') {
      const i = invoices.find(x => x.id === id) || paidInvoices.find(x => x.id === id);
      return i ? `INV-${i.invoice_number}${i.company_name ? ` · ${i.company_name}` : ''}${isPaidInv(id) ? ' (already paid)' : ''}` : 'an invoice';
    }
    if (type === 'bill') { const b = bills.find(x => x.id === id); return b ? `${b.supplier_name || 'Bill'}${b.bill_number ? ` #${b.bill_number}` : ''}` : 'a bill'; }
    if (type === 'expense') { const e = expenses.find(x => x.id === id); return e ? `${e.supplier_name || 'Expense'} expense` : 'an expense'; }
    if (type === 'refund') { const o = [...txns, ...done].find(x => x.id === id); return o ? `${o.payee || 'line'} ${fmtMoney(o.amount, o.currency)} on ${fmtD(o.booking_date)}` : 'another line'; }
    return '';
  };
  // The AI's pick, if it still points at something open.
  const aiFor = (t) => {
    const m = t.ai_match;
    if (!m) return null;
    if (m.kind === 'invoice' && m.target_id && !invoices.some(x => x.id === m.target_id) && !(isPaidInv(m.target_id) && !linkedIds.has(m.target_id))) return { ...m, stale: true };
    if (m.kind === 'bill' && m.target_id && !bills.some(x => x.id === m.target_id)) return { ...m, stale: true };
    if (m.kind === 'expense' && m.target_id && !expenses.some(x => x.id === m.target_id)) return { ...m, stale: true };
    return m;
  };

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return txns.filter(t => (dir === 'all' || (dir === 'in' ? t.amount > 0 : t.amount < 0))
      && (!s || `${t.payee || ''} ${t.description || ''} ${Math.abs(t.amount).toFixed(2)}`.toLowerCase().includes(s)));
  }, [txns, dir, q]);

  if (!allowed) {
    return (
      <div className="h-full flex items-center justify-center p-6">
        <div className="glass-card rounded-2xl p-6 max-w-sm text-center space-y-2">
          <Lock size={22} className="mx-auto text-dim" />
          <div className="text-paper font-semibold">The bank feed is private</div>
          <div className="text-sm text-muted">Ask the owner to switch on bank feed access for you in Users.</div>
        </div>
      </div>
    );
  }

  const inCount = txns.filter(t => t.amount > 0).length;
  const outCount = txns.length - inCount;

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 lg:px-6 py-4 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Landmark size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Bank feed</div>
            <div className="text-xs text-muted">Match money in to invoices, money out to bills and expenses</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={linkAllPaid} disabled={busy === 'linkall'} title="Links money in to invoices already marked paid, where the reference names the invoice and the amount agrees" className="btn-ghost px-3 py-2 rounded-xl text-sm">{busy === 'linkall' ? 'Linking…' : 'Link paid invoices'}</button>
          <button onClick={() => askAi()} disabled={busy === 'ai'} className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5"><Sparkles size={14} /> {busy === 'ai' ? 'Thinking…' : 'Ask AI to match'}</button>
          <button onClick={connect} disabled={busy === 'institutions'} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> {busy === 'institutions' ? 'Loading…' : 'Connect bank'}</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 lg:p-6">
        <div className="max-w-4xl mx-auto space-y-4">
          {err && <div className="glass-card rounded-2xl p-3 text-sm text-red-600 flex items-start gap-2"><AlertTriangle size={15} className="mt-0.5 shrink-0" /><span className="flex-1">{err}</span><button onClick={() => setErr('')}><X size={14} /></button></div>}
          {note && <div className="glass-card rounded-2xl p-3 text-sm text-emerald-700">{note}</div>}

          {connections.map(c => (
            <div key={c.id} className="glass-card rounded-2xl overflow-hidden">
              <div className="px-4 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
                <span className={`w-2 h-2 rounded-full shrink-0 ${c.status === 'LN' ? 'bg-emerald-500' : c.status === 'EX' ? 'bg-red-500' : 'bg-amber-400'}`} />
                <h3 className="text-[13px] font-bold text-paper">{c.institution_name || c.institution_id}</h3>
                {c.last_synced_at && <span className="text-[10px] text-dim">synced {new Date(c.last_synced_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                {c.status === 'SA' && <button onClick={() => activate(c.id)} className="ml-auto text-xs text-ember font-medium">{busy === 'activate' ? 'Checking…' : "I've tapped Allow in Monzo"}</button>}
                {c.status === 'EX' && <span className="ml-auto text-xs text-red-600">Access ended. Click Connect bank to reconnect.</span>}
                {c.status === 'LN' && <button onClick={() => refresh(c.id)} disabled={busy === 'sync'} className="ml-auto text-xs text-ember font-medium inline-flex items-center gap-1"><RefreshCw size={12} className={busy === 'sync' ? 'animate-spin' : ''} /> Refresh</button>}
              </div>
              {accounts.filter(a => a.connection_id === c.id && a.active).map(a => (
                <div key={a.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <div className="flex-1 min-w-0"><div className="text-paper truncate">{a.name}</div><div className="text-[10px] text-dim">{a.iban || ''}</div></div>
                  {a.balance != null && <div className="tabular-nums text-paper font-semibold">{fmtMoney(a.balance, a.currency)}</div>}
                </div>
              ))}
            </div>
          ))}
          {connections.length === 0 && <div className="glass-card rounded-2xl p-8 text-center text-dim text-sm">No bank connected yet. Click "Connect bank" to link Monzo.</div>}

          <div className="glass-card rounded-2xl overflow-hidden">
            <div className="px-4 py-3 border-b border-bdr flex items-center gap-2 flex-wrap">
              <h3 className="text-[13px] font-bold text-paper mr-2">To match</h3>
              {[['all', `All ${txns.length}`], ['in', `Money in ${inCount}`], ['out', `Money out ${outCount}`]].map(([k, l]) => (
                <button key={k} onClick={() => setDir(k)} className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${dir === k ? 'bg-ember/15 text-ember-deep' : 'text-muted hover:text-paper'}`}>{l}</button>
              ))}
              <div className="ml-auto flex items-center gap-1.5 bg-card border border-bdr rounded-lg px-2 py-1">
                <Search size={13} className="text-dim" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search payee, reference, amount" className="bg-transparent text-sm text-paper outline-none w-44" />
              </div>
            </div>
            <div className="divide-y divide-bdr/60">
              {visible.length === 0 ? <div className="px-4 py-8 text-center text-dim text-sm">Nothing to match here.</div>
                : visible.map(t => <Row key={t.id} t={t} sug={suggestFor(t)} ai={aiFor(t)} docLabel={docLabel} nameOf={nameOf} catOf={catOf}
                    onMatch={(type, id) => (type === 'refund' ? pairRefund(t, [...txns, ...done].find(x => x.id === id)) : matchDoc(t, type, id))}
                    onFind={() => setMatchFor(t)} onBill={() => createBill(t)} onInvoice={() => createInvoice(t)}
                    onCard={() => setCardFor(t)} onIgnore={() => ignore(t)} onAsk={() => askAi([t.id])} />)}
            </div>
          </div>

          <div className="glass-card rounded-2xl overflow-hidden">
            <button onClick={() => setShowDone(v => !v)} className="w-full px-4 py-3 flex items-center gap-2 text-left">
              <h3 className="text-[13px] font-bold text-paper">Matched</h3><span className="text-xs text-dim">({done.length} recent)</span>
              <span className="ml-auto text-xs text-ember">{showDone ? 'Hide' : 'Show'}</span>
            </button>
            {showDone && (
              <div className="divide-y divide-bdr/60 border-t border-bdr">
                {done.map(t => (
                  <div key={t.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="text-paper truncate">{t.payee || t.description || 'Payment'}</div>
                      <div className="text-[10px] text-dim">{fmtD(t.booking_date)} · {t.matched_type === 'refund' ? 'refund pair' : t.matched_type}{t.assigned_to ? ` · ${nameOf(t.assigned_to)}` : ''}</div>
                    </div>
                    <div className={`tabular-nums shrink-0 ${t.amount > 0 ? 'text-emerald-600' : 'text-paper'}`}>{t.amount > 0 ? '+' : ''}{fmtMoney(t.amount, t.currency)}</div>
                    {['invoice', 'bill', 'expense'].includes(t.matched_type) && t.matched_id && <button onClick={() => onNavigate?.(t.matched_type, t.matched_id)} className="text-xs text-ember">Open</button>}
                    {['ignored', 'refund'].includes(t.matched_type) && <button onClick={() => undo(t)} className="text-xs text-dim hover:text-paper">Undo</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="text-[11px] text-dim">Read only: nothing is ever paid from here. Money in booked to an invoice is recorded as a bank payment on that invoice.</div>
        </div>
      </div>

      {matchFor && <FindMatch t={matchFor} invoices={invoices.filter(sameCcy(matchFor))} paidInvoices={paidInvoices.filter(x => !linkedIds.has(x.id) && sameCcy(matchFor)(x))} bills={bills.filter(sameCcy(matchFor))} expenses={expenses.filter(sameCcy(matchFor))} lines={[...txns, ...done]} ai={aiFor(matchFor)}
        onClose={() => setMatchFor(null)}
        onPick={(type, id) => (type === 'refund' ? pairRefund(matchFor, [...txns, ...done].find(x => x.id === id)) : matchDoc(matchFor, type, id))} />}
      {cardFor && <CardSpend t={cardFor} people={people} categories={categories} ai={aiFor(cardFor)} onClose={() => setCardFor(null)}
        onDone={async (person, cat, remember) => {
          const { data, error } = await invoke('bank-connect', { action: 'company_card', txn_id: cardFor.id, person_id: person, category_id: cat || null, remember, remember_pattern: cardFor.payee });
          if (error || data?.error) { fail('Could not book it. ' + (data?.error || error?.message || '')); return; }
          flash(`Booked as company card spend for ${nameOf(person)}. They have been asked for the receipt.`);
          setCardFor(null); load();
        }} />}

      {brexOpen && <BrexConnect onClose={() => setBrexOpen(false)} onDone={(res) => {
        setBrexOpen(false);
        const n = (res.accounts || []).reduce((s, a) => s + (a.imported || 0), 0);
        const bad = (res.accounts || []).filter(a => a.error).map(a => `${a.account}: ${a.error}`);
        flash(`Brex connected: ${n} lines imported.`); if (bad.length) fail(bad.join(' '));
        load();
      }} />}

      {picker && (
        <Modal title="Choose your bank" onClose={() => setPicker(null)}>
          {picker.map(i => <button key={i.id} onClick={() => pickBank(i)} className="w-full px-3 py-2.5 rounded-xl hover:bg-card text-left text-sm text-paper">{i.name}</button>)}
        </Modal>
      )}
    </div>
  );
}

function Row({ t, sug, ai, docLabel, nameOf, catOf, onMatch, onFind, onBill, onInvoice, onCard, onIgnore, onAsk }) {
  const inMoney = Number(t.amount) > 0;
  // The rule based match wins when both agree; the AI fills the gaps.
  const aiTarget = ai && !ai.stale && ['invoice', 'bill', 'expense', 'refund'].includes(ai.kind) && ai.target_id;
  const sameAsSug = sug && aiTarget && sug.id === ai.target_id;
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-paper font-medium truncate">{t.payee || t.description || 'Payment'}</div>
          <div className="text-[11px] text-dim truncate">
            {inMoney ? 'Money in · ' : ''}{t.status === 'pending' ? 'Pending · ' : ''}{fmtD(t.booking_date)}{t.description && t.description !== t.payee ? ` · ${t.description}` : ''}
          </div>
        </div>
        <div className={`tabular-nums font-semibold shrink-0 ${inMoney ? 'text-emerald-600' : 'text-paper'}`}>{inMoney ? '+' : ''}{fmtMoney(t.amount, t.currency)}</div>
      </div>

      {ai && (
        <div className="text-[11px] flex items-start gap-1.5 text-muted">
          <Sparkles size={12} className="text-uv mt-0.5 shrink-0" />
          <span>
            <b className="text-paper">{KIND_LABEL[ai.kind] || ai.kind}</b>
            {aiTarget ? `: ${docLabel(ai.kind, ai.target_id)}` : ''}
            {ai.kind === 'company_card' && ai.person_id ? `: ${nameOf(ai.person_id)}` : ''}
            {ai.category_id && catOf(ai.category_id) ? ` · ${catOf(ai.category_id)}` : ''}
            {` · ${Math.round((ai.confidence || 0) * 100)}% sure. `}{ai.reason}
            {ai.stale ? (ai.kind === 'invoice' ? ' (send the invoice, then it can be matched)' : ' (that document is no longer open)') : ''}
          </span>
        </div>
      )}

      <div className="flex items-center gap-1.5 flex-wrap">
        {sug && <Btn tone="go" onClick={() => onMatch(sug.type, sug.id)}>{sug.type === 'invoice_paid' ? 'Link' : 'Match'} {docLabel(sug.type, sug.id)}{sug.part ? ' (part)' : ''}</Btn>}
        {aiTarget && !sameAsSug && <Btn tone="ai" onClick={() => onMatch(ai.kind, ai.target_id)}>{ai.kind === 'refund' ? 'Pair refund' : 'Match'}: {docLabel(ai.kind, ai.target_id)}</Btn>}
        <Btn onClick={onFind}>Find match…</Btn>
        {inMoney ? <Btn onClick={onInvoice}>Create invoice</Btn> : <Btn onClick={onBill}>Create bill</Btn>}
        {!inMoney && <Btn onClick={onCard}>Company card spend…</Btn>}
        <Btn tone="quiet" onClick={onIgnore}>Ignore</Btn>
        {!ai && <Btn tone="quiet" onClick={onAsk}>Ask AI</Btn>}
      </div>
    </div>
  );
}

function Btn({ children, onClick, tone }) {
  const cls = tone === 'go' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-semibold'
    : tone === 'ai' ? 'bg-uv/10 text-uv hover:bg-uv/20 font-semibold'
      : tone === 'quiet' ? 'text-dim hover:text-paper'
        : 'bg-ember/10 text-ember-deep hover:bg-ember/20 font-semibold';
  return <button onClick={onClick} className={`px-2.5 py-1 text-xs rounded-lg max-w-full truncate ${cls}`}>{children}</button>;
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div className={`glass-card w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-2xl`} onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between"><div className="text-base font-bold text-paper">{title}</div><button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button></div>
        <div className="p-3 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// 4: search across everything this line could be, closest amount first.
function FindMatch({ t, invoices, paidInvoices = [], bills, expenses, lines, ai, onClose, onPick }) {
  const inMoney = Number(t.amount) > 0;
  const tabs = inMoney ? [['invoice', 'Invoices'], ['refund', 'Refund of a payment']] : [['bill', 'Bills'], ['expense', 'Expenses'], ['refund', 'Refund of a payment']];
  const [tab, setTab] = useState(ai?.kind && tabs.some(([k]) => k === ai.kind) ? ai.kind : tabs[0][0]);
  const [s, setS] = useState('');
  const amt = Math.abs(Number(t.amount));
  const rows = useMemo(() => {
    let list = [];
    if (tab === 'invoice') list = [
      ...invoices.map(i => ({ id: i.id, title: `INV-${i.invoice_number} · ${i.company_name || 'No customer'}`, sub: `owed ${fmtMoney(invoiceBalance(i), i.currency)}${i.due_date ? ` · due ${fmtD(i.due_date)}` : ''}`, amount: invoiceBalance(i), text: `inv-${i.invoice_number} ${i.invoice_number} ${i.company_name || ''}` })),
      // Already marked paid: picking one only links the bank line to it.
      ...paidInvoices.map(i => ({ id: i.id, paid: true, title: `INV-${i.invoice_number} · ${i.company_name || 'No customer'}`, sub: `already paid ${fmtMoney(i.amount_paid || i.total, i.currency)}${i.paid_at ? ` on ${fmtD(i.paid_at)}` : ''}, links only`, amount: Number(i.amount_paid || i.total || 0), text: `inv-${i.invoice_number} ${i.invoice_number} ${i.company_name || ''}` })),
    ];
    if (tab === 'bill') list = bills.map(b => ({ id: b.id, title: `${b.supplier_name || 'Bill'}${b.bill_number ? ` #${b.bill_number}` : ''}`, sub: `owed ${fmtMoney(Number(b.total) - Number(b.amount_paid || 0), b.currency)}${b.description ? ` · ${b.description}` : ''}`, amount: Number(b.total) - Number(b.amount_paid || 0), text: `${b.supplier_name || ''} ${b.description || ''} ${b.bill_number || ''}` }));
    if (tab === 'expense') list = expenses.map(e => ({ id: e.id, title: `${e.supplier_name || 'Someone'}: ${e.description || 'expense'}`, sub: `${fmtMoney(e.total, e.currency)} · ${fmtD(e.expense_date)}`, amount: Number(e.total), text: `${e.supplier_name || ''} ${e.description || ''}` }));
    if (tab === 'refund') list = lines.filter(o => o.id !== t.id && ccy(o) === ccy(t) && Math.sign(o.amount) !== Math.sign(t.amount) && o.matched_type !== 'refund')
      .map(o => ({ id: o.id, title: `${o.payee || 'Payment'} ${o.amount > 0 ? '+' : ''}${fmtMoney(o.amount, o.currency)}`, sub: `${fmtD(o.booking_date)}${o.description ? ` · ${o.description}` : ''}${o.reconciled ? ` · booked as ${o.matched_type}` : ''}`, amount: Math.abs(o.amount), text: `${o.payee || ''} ${o.description || ''}` }));
    const k = s.trim().toLowerCase();
    return list.filter(r => !k || `${r.text} ${r.amount.toFixed(2)}`.toLowerCase().includes(k))
      .sort((a, b) => (b.id === ai?.target_id) - (a.id === ai?.target_id) || Math.abs(a.amount - amt) - Math.abs(b.amount - amt));
  }, [tab, s, invoices, bills, expenses, lines, t, ai, amt]);
  return (
    <Modal wide title={`Match ${inMoney ? '+' : ''}${fmtMoney(t.amount, t.currency)} · ${t.payee || 'payment'}`} onClose={onClose}>
      <div className="flex gap-1.5 mb-2 flex-wrap">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`px-2.5 py-1 rounded-lg text-xs font-semibold ${tab === k ? 'bg-ember/15 text-ember-deep' : 'text-muted'}`}>{l}</button>)}
      </div>
      <div className="flex items-center gap-1.5 bg-card border border-bdr rounded-lg px-2 py-1.5 mb-2">
        <Search size={14} className="text-dim" />
        <input autoFocus value={s} onChange={e => setS(e.target.value)} placeholder="Search number, name or amount" className="bg-transparent text-sm text-paper outline-none flex-1" />
      </div>
      <div className="space-y-1">
        {rows.length === 0 ? <div className="p-4 text-center text-dim text-sm">Nothing found.</div> : rows.slice(0, 80).map(r => (
          <button key={r.id} onClick={() => onPick(tab, r.id)} className="w-full px-3 py-2 rounded-xl hover:bg-card text-left flex items-center gap-2">
            <div className="flex-1 min-w-0"><div className="text-sm text-paper truncate">{r.title}</div><div className="text-[11px] text-dim truncate">{r.sub}</div></div>
            {r.paid && <span className="text-[10px] font-bold text-dim shrink-0">paid</span>}
            {r.id === ai?.target_id && <span className="text-[10px] font-bold text-uv shrink-0">AI pick</span>}
            {Math.abs(r.amount - amt) < 0.005 && <span className="text-[10px] font-bold text-emerald-600 shrink-0">exact</span>}
          </button>
        ))}
      </div>
    </Modal>
  );
}

// 7: card spend in a person's name; they get asked for the receipt.
function CardSpend({ t, people, categories, ai, onClose, onDone }) {
  const [person, setPerson] = useState(ai?.kind === 'company_card' && ai.person_id ? ai.person_id : '');
  const [cat, setCat] = useState(ai?.category_id || '');
  const [remember, setRemember] = useState(false);
  const [saving, setSaving] = useState(false);
  const input = 'w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper';
  return (
    <Modal title={`Company card spend · ${fmtMoney(Math.abs(t.amount), t.currency)}`} onClose={onClose}>
      <div className="space-y-3 p-1">
        <div className="text-sm text-muted">{t.payee || t.description} on {fmtD(t.booking_date)}. It becomes a company card expense in their name (already paid, nothing to reimburse), and they are asked to attach the receipt and submit it.</div>
        <div><div className="text-[11px] text-dim mb-1">Who spent it</div>
          <select className={input} value={person} onChange={e => setPerson(e.target.value)}><option value="">Choose…</option>{people.map(p => <option key={p.id} value={p.id}>{p.display_name}</option>)}</select></div>
        <div><div className="text-[11px] text-dim mb-1">Category</div>
          <select className={input} value={cat} onChange={e => setCat(e.target.value)}><option value="">Choose…</option>{categories.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></div>
        <label className="flex items-center gap-2 text-sm text-paper"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
          Always do this for "{t.payee || 'this payee'}"</label>
        <button disabled={!person || saving} onClick={async () => { setSaving(true); await onDone(person, cat, remember); setSaving(false); }}
          className="btn-glass w-full py-2 rounded-xl text-sm font-semibold disabled:opacity-50">{saving ? 'Booking…' : 'Book and ask for the receipt'}</button>
      </div>
    </Modal>
  );
}

// Brex has no sign in page for apps like this: an admin makes a read only
// token in Brex and pastes it here once. It goes straight to the server and
// is never shown again.
function BrexConnect({ onClose, onDone }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    const { data, error } = await invoke('bank-connect', { action: 'brex_connect', token });
    setBusy(false);
    if (error || data?.error) { setErr(data?.error || error?.message || 'Could not connect.'); return; }
    setToken(''); onDone(data);
  };
  return (
    <Modal title="Connect Brex (US, dollars)" onClose={onClose}>
      <div className="space-y-3 p-1 text-sm">
        <ol className="list-decimal pl-5 space-y-1 text-muted">
          <li>In Brex, go to <b className="text-paper">Settings, Developer</b> and click <b className="text-paper">Create token</b>.</li>
          <li>Name it <b className="text-paper">ServOS CRM</b> and tick only the read scopes: <b className="text-paper">accounts.cash.readonly, transactions.cash.readonly, accounts.card.readonly, transactions.card.readonly</b>.</li>
          <li>Click Allow access, copy the token and paste it below.</li>
        </ol>
        <input type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="bxt_…"
          className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-paper" />
        {err && <div className="text-red-600 text-xs">{err}</div>}
        <button disabled={busy || token.trim().length < 20} onClick={go} className="btn-glass w-full py-2 rounded-xl font-semibold disabled:opacity-50">{busy ? 'Connecting and importing…' : 'Connect Brex'}</button>
        <div className="text-[11px] text-dim">Read only. The CRM can never move money in Brex.</div>
      </div>
    </Modal>
  );
}
