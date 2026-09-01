import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Receipt, Plus, Repeat, X, Trash2, FileDown, Download } from 'lucide-react';
import { fmtMoney, sumByCurrency, fmtByCurrency, currencySymbol, taxLabelFor } from '../../lib/money';
import { useStickyState } from '../../lib/stickyState';
import { downloadListPdf } from '../../lib/listPdf';

// Currency-aware and back-compatible: money(v) keeps meaning GBP for every
// existing caller, money(v, inv.currency) renders the document's own currency.
export const money = (v, currency = 'GBP') => fmtMoney(v, currency);
export const curOf = (x) => x?.currency || 'GBP';
const fmtD = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

// Effective display status: sent/viewed past due = overdue
export const invStatus = (inv) => {
  if (['paid', 'void', 'draft'].includes(inv.status)) return inv.status;
  if (inv.due_date && new Date(inv.due_date) < new Date(new Date().toDateString())) return 'overdue';
  return inv.status;
};
export const INV_BADGE = {
  draft: 'bg-slate-200 text-slate-600', sent: 'bg-blue-100 text-blue-700', viewed: 'bg-indigo-100 text-indigo-700',
  paid: 'bg-emerald-100 text-emerald-700', overdue: 'bg-red-100 text-red-700', void: 'bg-slate-100 text-slate-400',
};
const FIELD_LABEL = { all: 'all fields', company: 'customer', location: 'location', number: 'invoice number', po: 'PO number' };

// A printed total obeys the same rule as the headline stats: £ and $ are never
// added together. fmtByCurrency writes '£1,200.00 + $300.00', so a dual-region
// list can never be read as one invented figure.
const totalNote = (label, rows, value) => `${label}: ${fmtByCurrency(sumByCurrency(rows, value))}`;

export default function InvoicesPanel({ profile, onNavigate }) {
  const [invoices, setInvoices] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [locations, setLocations] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [products, setProducts] = useState([]);
  // Chasing payment means opening an invoice and coming back over and over, so
  // the tab, status filter and search you were working survive the round trip.
  const [filters, setFilters] = useStickyState('invoices', {
    tab: 'invoices', statusFilter: 'all', search: '', searchField: 'all',
    cols: { num: '', company: '', location: '', dueFrom: '', dueTo: '', min: '', max: '' },
  });
  const { tab, statusFilter, search, searchField } = filters;
  const cols = filters.cols || { num: '', company: '', location: '', dueFrom: '', dueTo: '', min: '', max: '' };
  const setFilter = (k, v) => setFilters(p => ({ ...p, [k]: v }));
  const [editSched, setEditSched] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const [i, r, c, l, ct, pr] = await Promise.all([
      supabase.from('invoices').select('*, company:companies(name), location:locations(name)').order('created_at', { ascending: false }),
      supabase.from('recurring_invoices').select('*, company:companies(name), location:locations(name)').order('created_at', { ascending: false }),
      supabase.from('companies').select('id, name').order('name'),
      supabase.from('locations').select('id, name, company_id').order('name'),
      supabase.from('contacts').select('id, first_name, last_name, email').order('last_name'),
      supabase.from('products').select('id, name, description, default_price').eq('active', true).order('name'),
    ]);
    setInvoices(i.data || []); setSchedules(r.data || []); setCompanies(c.data || []);
    setLocations(l.data || []); setContacts(ct.data || []); setProducts(pr.data || []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const newInvoice = async () => {
    const { data, error } = await supabase.from('invoices').insert({
      status: 'draft', created_by: profile.id,
      due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
    }).select('id').single();
    if (error) { alert(error.message); return; }
    onNavigate?.('invoice', data.id);
  };

  const [pdfFor, setPdfFor] = useState(null);   // invoice id currently rendering

  // One invoice → its own PDF, straight from the list. Fetches the pieces the
  // document needs (lines, seller, bill-to) only when asked, so opening the
  // list stays cheap.
  const downloadOne = async (inv, e) => {
    e.stopPropagation();                        // the row navigates; the button must not
    setPdfFor(inv.id);
    try {
      const [{ data: lines }, { data: seller }, { data: contact }] = await Promise.all([
        supabase.from('invoice_line_items').select('*').eq('invoice_id', inv.id).order('sort'),
        supabase.from('support_settings')
          .select('business_name, business_address, business_email, business_phone, logo_url, quote_accent, invoice_terms')
          .eq('id', 1).maybeSingle(),
        inv.contact_id
          ? supabase.from('contacts').select('first_name, last_name, email').eq('id', inv.contact_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      const company = companies.find(c => c.id === inv.company_id);
      const location = locations.find(l => l.id === inv.location_id);
      const addr = (o) => o ? [o.address, o.city, o.postcode].filter(Boolean).join(', ') : '';
      const rows = lines || [];
      const subtotal = rows.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
      const tax = rows.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unit_price) || 0) * (Number(l.tax_rate) || 0) / 100, 0);
      const { downloadInvoicePdf } = await import('../../lib/invoicePdf');
      await downloadInvoicePdf({
        inv: { ...inv, terms: inv.terms || seller?.invoice_terms },
        lines: rows,
        // Totals come from the saved header, falling back to the lines — an
        // invoice already sent must print the figure the customer was given.
        totals: { subtotal: inv.subtotal ?? subtotal, tax: inv.tax_amount ?? tax,
                  total: inv.total ?? (subtotal + tax), paid: inv.amount_paid },
        seller: {
          name: seller?.business_name, address: seller?.business_address,
          email: seller?.business_email, phone: seller?.business_phone,
          logo_url: seller?.logo_url, accent: seller?.quote_accent,
        },
        billTo: {
          companyName: company?.name, companyAddress: addr(company),
          contactName: contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '',
          contactEmail: contact?.email,
          locationName: location?.name, locationAddress: addr(location),
        },
        fmt: (v) => money(v, curOf(inv)), taxLabel: 'VAT', dateLocale: 'en-GB',
      });
    } catch (err) { alert('Could not build that PDF: ' + err.message); }
    setPdfFor(null);
  };

  const custName = (x) => x.location?.name || x.company?.name || x.label || '—';
  // The invoice is TO a company, FOR a site. Showing only one of them meant
  // "Coffee Boy - Preston" never said whose account it belongs to, and
  // "Lightspeed Netherlands B.V." never said which of their 24 sites it was.
  const partiesOf = (x) => ({
    company: x.company?.name || null,
    site: x.location?.name || null,
  });


  // Never sum £ and $ into one figure — each currency keeps its own total.
  const open = invoices.filter(i => ['sent', 'viewed'].includes(i.status));
  const outstanding = sumByCurrency(open, i => i.total);
  const overdueList = invoices.filter(i => invStatus(i) === 'overdue');
  const overdueSum = sumByCurrency(overdueList, i => i.total);
  const mStart = new Date(); mStart.setDate(1);
  const paidThisMonth = sumByCurrency(
    invoices.filter(i => i.status === 'paid' && i.paid_at && new Date(i.paid_at) >= mStart),
    i => i.amount_paid ?? i.total ?? 0);

  const matchesTab = (inv) => {
    const st = invStatus(inv);
    if (statusFilter === 'all') return true;
    if (statusFilter === 'sent') return st === 'sent' || st === 'viewed';
    return st === statusFilter; // draft, overdue, paid
  };
  // Every column filters independently and they AND together — the old single
  // search box could only ever ask about one field at a time.
  const colMatch = (inv) => {
    const c = cols;
    // Match against what the row actually SHOWS, including the label fallback
    // in the company column. A filter that hides a row you can read is worse
    // than no filter, because it looks like the invoice does not exist.
    const { company, site } = partiesOf(inv);
    if (c.num) {
      const digits = c.num.replace(/\D/g, '');
      const full = `inv-${inv.invoice_number}`.toLowerCase();
      // Bare digits match the number; anything else matches the printed form.
      const hit = digits ? String(inv.invoice_number).includes(digits) : full.includes(c.num.toLowerCase());
      if (!hit) return false;
    }
    if (c.company && !(company || inv.label || '').toLowerCase().includes(c.company.toLowerCase())) return false;
    if (c.location && !(site || '').toLowerCase().includes(c.location.toLowerCase())) return false;
    if (c.dueFrom && (!inv.due_date || inv.due_date < c.dueFrom)) return false;
    if (c.dueTo && (!inv.due_date || inv.due_date > c.dueTo)) return false;
    if (c.min && !(Number(inv.total) >= Number(c.min))) return false;
    if (c.max && !(Number(inv.total) <= Number(c.max))) return false;
    return true;
  };
  const q = search.trim().toLowerCase();
  const matchesSearch = (inv) => {
    if (!q) return true;
    const comp = (inv.company?.name || '').toLowerCase();
    const loc = (inv.location?.name || '').toLowerCase();
    const num = `inv-${inv.invoice_number}`.toLowerCase();
    const label = (inv.label || '').toLowerCase();
    const po = (inv.po_number || '').toLowerCase();
    if (searchField === 'company') return comp.includes(q);
    if (searchField === 'location') return loc.includes(q);
    if (searchField === 'number') return num.includes(q) || String(inv.invoice_number || '').includes(q);
    if (searchField === 'po') return po.includes(q);
    return comp.includes(q) || loc.includes(q) || num.includes(q) || label.includes(q) || po.includes(q);
  };
  const filtered = invoices.filter(i => matchesTab(i) && matchesSearch(i) && colMatch(i));

  // What a schedule bills each run. Shared with the row below so the printed
  // list and the screen can never quietly disagree about the number.
  const schedAmount = (s) => (Array.isArray(s.lines) ? s.lines : [])
    .reduce((sum, l) => sum + (Number(l.qty) || 1) * (Number(l.unit_price) || 0), 0) * (1 + Number(s.tax_rate || 0) / 100);

  const exportPdf = async () => {
    setPdfBusy(true);
    try {
      if (tab === 'invoices') {
        const active = [];
        if (statusFilter !== 'all') active.push(`Status: ${statusFilter === 'sent' ? 'sent or viewed' : statusFilter}`);
        if (q) active.push(`Search: "${search.trim()}" in ${FIELD_LABEL[searchField]}`);
        await downloadListPdf({
          title: 'Invoices',
          columns: ['Invoice', 'Customer', 'PO', 'Issued', 'Due', 'Status', 'Currency', 'Total'],
          // `filtered` is the exact array the list maps over, so the PDF can
          // never include an invoice the current filter is hiding.
          rows: filtered.map(inv => [
            `INV-${inv.invoice_number}`, custName(inv), inv.po_number || '—',
            fmtD(inv.issue_date), fmtD(inv.due_date),
            invStatus(inv), curOf(inv), money(inv.total, curOf(inv)),
          ]),
          filters: active,
          footNote: totalNote('Total', filtered, i => i.total),
        });
      } else {
        await downloadListPdf({
          title: 'Recurring invoice schedules',
          columns: ['Schedule', 'Customer', 'Frequency', 'Day', 'Next run', 'Sending', 'State', 'Currency', 'Amount'],
          rows: schedules.map(s => [
            s.label || custName(s), custName(s), s.frequency, s.day_of_month, fmtD(s.next_run),
            s.auto_send ? 'Auto-send' : 'Draft only', s.active ? 'Active' : 'Paused',
            curOf(s), money(schedAmount(s), curOf(s)),
          ]),
          footNote: totalNote('Per run', schedules, schedAmount),
        });
      }
    } finally { setPdfBusy(false); }
  };

  const input = "px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  // One definition for header, filters and rows so the columns cannot drift.
  const GRID = 'grid items-center gap-3 px-5 grid-cols-[96px_minmax(0,1.4fr)_minmax(0,1.4fr)_178px_108px_84px_34px]';
  const colInput = 'w-full px-2 py-1 bg-card border border-bdr rounded-lg text-[11px] text-paper placeholder-dim focus:outline-none focus:border-ember';
  // Safari draws an EMPTY date box with today's date greyed in, so an untouched
  // filter looks like it is already narrowing the list. Never let the browser's
  // empty state decide whether a filter reads as on: an active one is outlined.
  const colCls = (v) => `${colInput}${v ? ' border-ember bg-ember/10' : ''}`;
  const setCol = (k, v) => setFilter('cols', { ...cols, [k]: v });
  const colsActive = Object.values(cols).some(Boolean);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Receipt size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Invoices</div>
            <div className="text-xs text-muted">Raise, send and track payment</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 bg-card rounded-xl p-0.5">
            <button onClick={() => setFilter('tab', 'invoices')} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'invoices' ? 'bg-ember text-white' : 'text-muted'}`}>Invoices</button>
            <button onClick={() => setFilter('tab', 'recurring')} className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === 'recurring' ? 'bg-ember text-white' : 'text-muted'}`}><Repeat size={12} /> Recurring</button>
          </div>
          <button onClick={exportPdf} disabled={pdfBusy || !(tab === 'invoices' ? filtered.length : schedules.length)}
            title="Download the list you are looking at as a PDF"
            className="btn-ghost px-3 py-2 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50">
            <FileDown size={14} /> {pdfBusy ? 'Preparing…' : 'PDF'}
          </button>
          {canWrite && (tab === 'invoices'
            ? <button onClick={newInvoice} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New invoice</button>
            : <button onClick={() => setEditSched({})} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New schedule</button>)}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1100px] mx-auto space-y-5">

          {/* Headline */}
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Outstanding" value={fmtByCurrency(outstanding)} sub={`${open.length} open invoice${open.length !== 1 ? 's' : ''}`} />
            <Stat label="Overdue" value={fmtByCurrency(overdueSum)} sub={`${overdueList.length} overdue`} tone={overdueList.length ? 'red' : null} />
            <Stat label="Paid this month" value={fmtByCurrency(paidThisMonth)} tone="emerald" />
          </div>

          {tab === 'invoices' ? (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-bdr space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-[13px] font-bold text-paper">Invoices</h3>
                  <span className="text-xs text-dim font-mono">({filtered.length})</span>
                  <div className="ml-auto flex items-center gap-1 flex-wrap">
                    {[['all', 'All'], ['draft', 'Draft'], ['sent', 'Sent'], ['overdue', 'Overdue'], ['paid', 'Paid']].map(([k, lbl]) => (
                      <button key={k} onClick={() => setFilter('statusFilter', k)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition ${statusFilter === k ? 'bg-ember text-white' : 'text-muted hover:text-paper'}`}>{lbl}</button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select className={input + ' !py-1.5 text-xs shrink-0'} value={searchField} onChange={e => setFilter('searchField', e.target.value)}>
                    <option value="all">All fields</option>
                    <option value="company">Customer</option>
                    <option value="location">Location</option>
                    <option value="number">Invoice #</option>
                    <option value="po">PO number</option>
                  </select>
                  <input className={input + ' !py-1.5 text-xs flex-1'} value={search} onChange={e => setFilter('search', e.target.value)}
                    placeholder="Search invoices…" />
                  {search && <button onClick={() => setFilter('search', '')} className="text-xs text-dim hover:text-paper px-2 shrink-0">Clear</button>}
                </div>
              </div>
              {/* Column headings, then a filter under each one. The filters
                  combine, so "Coffee Boy" + overdue + due-before is a single
                  question instead of three passes through the list. */}
              <div className={`${GRID} py-2 border-b border-bdr`}>
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-ember">Inv #</div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-ember">Company name</div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-ember">Location name</div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-ember text-right">Due date</div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-ember text-right">Amount</div>
                <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-ember text-center">Status</div>
                <div />
              </div>
              <div className={`${GRID} py-2 border-b border-bdr bg-card/40`}>
                <input className={colCls(cols.num)} value={cols.num} onChange={e => setCol('num', e.target.value)} placeholder="1085" />
                <input className={colCls(cols.company)} value={cols.company} onChange={e => setCol('company', e.target.value)} placeholder="Filter company…" />
                <input className={colCls(cols.location)} value={cols.location} onChange={e => setCol('location', e.target.value)} placeholder="Filter location…" />
                {/* Two boxes because a due date is a RANGE. They were unlabelled
                    and read as one date repeated. A date input cannot carry a
                    placeholder, so the words have to be on the page. */}
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-1">
                    <span className="text-[9px] font-mono uppercase text-dim w-7 shrink-0">From</span>
                    <input type="date" className={colCls(cols.dueFrom)} value={cols.dueFrom} onChange={e => setCol('dueFrom', e.target.value)} />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-[9px] font-mono uppercase text-dim w-7 shrink-0">To</span>
                    <input type="date" className={colCls(cols.dueTo)} value={cols.dueTo} onChange={e => setCol('dueTo', e.target.value)} />
                  </label>
                </div>
                <div className="flex flex-col gap-1">
                  <input className={colCls(cols.min) + ' text-right'} value={cols.min} onChange={e => setCol('min', e.target.value)} placeholder="min" inputMode="decimal" />
                  <input className={colCls(cols.max) + ' text-right'} value={cols.max} onChange={e => setCol('max', e.target.value)} placeholder="max" inputMode="decimal" />
                </div>
                <select className={colCls(statusFilter !== 'all')} value={statusFilter} onChange={e => setFilter('statusFilter', e.target.value)}>
                  <option value="all">All</option><option value="draft">Draft</option>
                  <option value="sent">Sent</option><option value="overdue">Overdue</option><option value="paid">Paid</option>
                </select>
                <div className="flex justify-center">
                  {colsActive && (
                    <button onClick={() => setFilter('cols', { num: '', company: '', location: '', dueFrom: '', dueTo: '', min: '', max: '' })}
                      title="Clear column filters" className="text-dim hover:text-red-600 text-xs">&times;</button>
                  )}
                </div>
              </div>
              <div className="divide-y divide-bdr">
                {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
                  : filtered.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">
                      {colsActive || search ? 'Nothing matches those filters.' : 'No invoices yet — raise your first one.'}
                    </div>
                  : filtered.map(inv => {
                    const st = invStatus(inv);
                    const { company, site } = partiesOf(inv);
                    return (
                      <div key={inv.id} onClick={() => onNavigate?.('invoice', inv.id)}
                        className={`${GRID} py-3 hover:bg-card/50 cursor-pointer`}>
                        <div className="font-mono text-xs text-dim">INV-{inv.invoice_number}</div>
                        <div className="min-w-0">
                          <div className="text-sm text-paper font-medium truncate">{company || inv.label || '—'}</div>
                          {inv.po_number && <div className="text-[10px] text-muted font-mono truncate">PO {inv.po_number}</div>}
                          {inv.recurring_id && <div className="text-[10px] text-uv flex items-center gap-1"><Repeat size={10} /> recurring</div>}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm text-muted truncate">{site || '—'}</div>
                          {inv.viewed_at && <div className="text-[10px] text-emerald-600 truncate">{'\u{1F441}'} Viewed {new Date(inv.viewed_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
                        </div>
                        <div className="text-xs text-muted text-right">Due {fmtD(inv.due_date)}</div>
                        <div className="text-sm font-semibold text-paper tabular-nums text-right">{money(inv.total, inv.currency)}</div>
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-lg text-center ${INV_BADGE[st]}`}>{st}</span>
                        <button onClick={(e) => downloadOne(inv, e)} disabled={pdfFor === inv.id}
                          title={`Download INV-${inv.invoice_number} as a PDF`}
                          className="p-1.5 rounded-lg text-dim hover:text-ember hover:bg-ember/10 transition disabled:opacity-40">
                          <Download size={15} />
                        </button>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="glass-card rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-bdr">
                <h3 className="text-[13px] font-bold text-paper">Recurring schedules</h3>
                <div className="text-[11px] text-dim">Invoices are generated and emailed automatically on the day they're due to go out (daily run at 6am).</div>
              </div>
              <div className="divide-y divide-bdr">
                {schedules.length === 0 ? <div className="p-8 text-center text-dim text-sm italic">No recurring invoices yet.</div>
                  : schedules.map(s => {
                    const amount = schedAmount(s);
                    return (
                      <div key={s.id} onClick={() => canWrite && setEditSched(s)}
                        className="px-5 py-3 flex items-center gap-4 hover:bg-card/50 cursor-pointer">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${s.active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-paper font-medium truncate">{s.label || custName(s)}</div>
                          <div className="text-[11px] text-muted">{custName(s)} · {s.frequency} on day {s.day_of_month}{s.auto_send ? ' · auto-send' : ' · draft only'}</div>
                        </div>
                        <div className="text-xs text-muted shrink-0">Next: {fmtD(s.next_run)}</div>
                        <div className="text-sm font-semibold text-paper tabular-nums shrink-0 w-24 text-right">{money(amount, s.currency)}</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      </div>

      {editSched && <ScheduleModal schedule={editSched} companies={companies} locations={locations} contacts={contacts}
        products={products} profile={profile} onClose={() => setEditSched(null)} onSaved={() => { setEditSched(null); load(); }} />}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'red' ? 'text-red-600' : tone === 'emerald' ? 'text-emerald-600' : 'text-paper';
  return (
    <div className="glass-card rounded-2xl p-4">
      <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-dim mt-0.5">{sub}</div>}
    </div>
  );
}

// Solid, always-readable fields (.r-field lives in index.css) — palette-independent,
// so the recurring-invoice modal stays readable on the white modal and matches the
// normal invoice editor's look.
const input = "w-full r-field";
const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-muted mb-1 block";

function ScheduleModal({ schedule, companies, locations, contacts, products = [], profile, onClose, onSaved }) {
  const s = schedule || {};
  const [f, setF] = useState({
    label: s.label || '', company_id: s.company_id || '', location_id: s.location_id || '', contact_id: s.contact_id || '',
    email_to: s.email_to || '', frequency: s.frequency || 'monthly', day_of_month: s.day_of_month ?? 1,
    next_run: s.next_run || new Date().toISOString().slice(0, 10), due_days: s.due_days ?? 14,
    currency: s.currency || 'GBP',
    tax_rate: s.tax_rate ?? (s.currency === 'USD' ? 0 : 20), terms: s.terms || '', notes: s.notes || '',
    auto_send: s.auto_send ?? true, active: s.active ?? true,
  });
  const [lines, setLines] = useState(Array.isArray(s.lines) && s.lines.length ? s.lines : [{ name: '', description: '', qty: 1, unit_price: 0 }]);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const setLine = (i, k, v) => setLines(p => p.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const locs = locations.filter(l => !f.company_id || l.company_id === f.company_id);

  const subtotal = lines.reduce((sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unit_price) || 0), 0);
  const total = subtotal * (1 + Number(f.tax_rate || 0) / 100);

  const save = async () => {
    if (!f.company_id && !f.contact_id) { alert('Pick a customer (company or contact)'); return; }
    const cleanLines = lines.filter(l => (l.name || '').trim());
    if (!cleanLines.length) { alert('Add at least one line item'); return; }
    const row = {
      label: f.label.trim() || null, company_id: f.company_id || null, location_id: f.location_id || null,
      contact_id: f.contact_id || null, email_to: f.email_to.trim() || null,
      frequency: f.frequency, day_of_month: Math.min(28, Math.max(1, Number(f.day_of_month) || 1)),
      next_run: f.next_run, due_days: Number(f.due_days) || 14, tax_rate: Number(f.tax_rate) || 0,
      currency: f.currency || 'GBP',
      lines: cleanLines.map(l => ({ name: l.name.trim(), description: (l.description || '').trim() || null, qty: Number(l.qty) || 1, unit_price: Number(l.unit_price) || 0 })),
      terms: f.terms.trim() || null, notes: f.notes.trim() || null,
      auto_send: f.auto_send, active: f.active, created_by: s.created_by || profile.id,
    };
    const { error } = s.id
      ? await supabase.from('recurring_invoices').update(row).eq('id', s.id)
      : await supabase.from('recurring_invoices').insert(row);
    if (error) { alert(error.message); return; }
    onSaved();
  };

  const del = async () => {
    if (!confirm('Delete this recurring schedule? Already-generated invoices are kept.')) return;
    await supabase.from('recurring_invoices').delete().eq('id', s.id);
    onSaved();
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between sticky top-0 glass-card z-10">
          <div className="text-base font-bold text-paper">{s.id ? 'Edit recurring invoice' : 'New recurring invoice'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Label (optional)</label><input className={input} value={f.label} onChange={e => set('label', e.target.value)} placeholder="e.g. Monthly SaaS plan" /></div>
            <div><label className={label}>Send to (email)</label><input className={input} value={f.email_to} onChange={e => set('email_to', e.target.value)} placeholder="defaults to contact's email" /></div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div><label className={label}>Company</label>
              <select className={input} value={f.company_id} onChange={e => { set('company_id', e.target.value); set('location_id', ''); }}>
                <option value="">—</option>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
            <div><label className={label}>Location</label>
              <select className={input} value={f.location_id} onChange={e => set('location_id', e.target.value)}>
                <option value="">—</option>{locs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
            <div><label className={label}>Contact</label>
              <select className={input} value={f.contact_id} onChange={e => set('contact_id', e.target.value)}>
                <option value="">—</option>{contacts.map(c => <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div><label className={label}>Frequency</label>
              <select className={input} value={f.frequency} onChange={e => set('frequency', e.target.value)}>
                <option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></div>
            <div><label className={label}>Day of month</label><input type="number" min="1" max="28" className={input} value={f.day_of_month} onChange={e => set('day_of_month', e.target.value)} /></div>
            <div><label className={label}>First / next run</label><input type="date" className={input} value={f.next_run} onChange={e => set('next_run', e.target.value)} /></div>
            <div><label className={label}>Due (days)</label><input type="number" className={input} value={f.due_days} onChange={e => set('due_days', e.target.value)} /></div>
          </div>

          {/* Lines */}
          <div className="glass-inner rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-3">
              <span className={label + ' !mb-0'}>Line items</span>
              <div className="ml-auto flex items-center gap-3">
                {products.length > 0 && (
                  <select className={input + ' !w-48 !py-1.5 text-xs'} value=""
                    onChange={e => {
                      const p = products.find(x => x.id === e.target.value);
                      if (p) setLines(prev => {
                        const blank = prev.length === 1 && !(prev[0].name || '').trim();
                        const line = { name: p.name, description: p.description || '', qty: 1, unit_price: Number(p.default_price) || 0 };
                        return blank ? [line] : [...prev, line];
                      });
                    }}>
                    <option value="">+ From products…</option>
                    {products.map(p => <option key={p.id} value={p.id}>{p.name} — {money(p.default_price, f.currency)}</option>)}
                  </select>
                )}
                <button onClick={() => setLines(p => [...p, { name: '', description: '', qty: 1, unit_price: 0 }])}
                  className="text-xs text-ember hover:text-ember-deep font-medium">+ Blank line</button>
              </div>
            </div>
            {lines.map((l, i) => (
              <div key={i} className="glass-inner rounded-xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <input className={input + ' flex-1'} value={l.name} onChange={e => setLine(i, 'name', e.target.value)} placeholder="Item name — e.g. Monthly subscription" />
                  <button onClick={() => setLines(p => p.filter((_, j) => j !== i))} title="Remove line" className="text-red-500 hover:text-red-600 text-lg leading-none shrink-0 px-1">&times;</button>
                </div>
                <input className={input + ' text-xs'} value={l.description || ''} onChange={e => setLine(i, 'description', e.target.value)} placeholder="Description (optional, shown on the invoice)" />
                <div className="grid grid-cols-2 gap-2">
                  <div><span className="text-[9px] text-muted block mb-0.5">Qty</span>
                    <input type="number" className={input} value={l.qty} onChange={e => setLine(i, 'qty', e.target.value)} placeholder="1" /></div>
                  <div><span className="text-[9px] text-muted block mb-0.5">Unit {currencySymbol(f.currency)} (ex {taxLabelFor(f.currency)})</span>
                    <input type="number" className={input} value={l.unit_price} onChange={e => setLine(i, 'unit_price', e.target.value)} placeholder="0.00" /></div>
                </div>
                <div className="text-right text-xs text-muted">Line total: <span className="text-paper font-mono font-semibold">{money((Number(l.qty) || 0) * (Number(l.unit_price) || 0), f.currency)}</span></div>
              </div>
            ))}
            <div className="flex justify-end gap-4 text-sm pt-1">
              <span className="text-muted">
                <select className={input + ' !w-20 !py-1 inline-block mr-2'} value={f.currency} onChange={e => set('currency', e.target.value)}>
                  <option value="GBP">GBP £</option><option value="USD">USD $</option>
                </select>
                {taxLabelFor(f.currency)} <input className={input + ' !w-16 !py-1 inline-block text-right ml-1'} value={f.tax_rate} onChange={e => set('tax_rate', e.target.value)} />%</span>
              <span className="font-bold text-paper tabular-nums">Total {money(total, f.currency)}</span>
            </div>
          </div>

          <div className="flex items-center gap-5">
            <Toggle checked={f.auto_send} onChange={v => set('auto_send', v)} label="Auto-send by email" />
            <Toggle checked={f.active} onChange={v => set('active', v)} label="Active" />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save schedule</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
            {s.id && <button onClick={del} className="ml-auto text-red-600 hover:bg-red-50 p-2 rounded-xl"><Trash2 size={16} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function Toggle({ checked, onChange, label: lbl }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex items-center gap-2">
      <span className={`relative w-9 h-5 rounded-full transition ${checked ? 'bg-emerald-500' : 'bg-slate-300'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className="text-sm text-paper">{lbl}</span>
    </button>
  );
}
