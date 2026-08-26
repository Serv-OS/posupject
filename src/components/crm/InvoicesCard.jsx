import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { currencyForCountry } from '../../lib/region';
import { Receipt, Repeat } from 'lucide-react';
import { money, invStatus, INV_BADGE } from './InvoicesPanel.jsx';

// Invoices associated with a record. Pass exactly one of companyId /
// locationId / contactId. "+ New" raises a draft pre-associated to the record.
export default function InvoicesCard({ companyId, locationId, contactId, profile, onNavigate }) {
  const [invoices, setInvoices] = useState([]);
  const [recurringCount, setRecurringCount] = useState(0);
  const canWrite = profile?.role === 'owner' || profile?.role === 'editor';

  const field = locationId ? 'location_id' : contactId ? 'contact_id' : 'company_id';
  const value = locationId || contactId || companyId;

  useEffect(() => {
    if (!value) return;
    supabase.from('invoices').select('*').eq(field, value).order('created_at', { ascending: false }).limit(8)
      .then(r => setInvoices(r.data || []));
    supabase.from('recurring_invoices').select('id', { count: 'exact', head: true }).eq(field, value).eq('active', true)
      .then(r => setRecurringCount(r.count || 0));
  }, [field, value]);

  const newInvoice = async () => {
    const seed = { status: 'draft', created_by: profile.id, [field]: value, due_date: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10) };
    // location implies its company for clean rollups
    if (locationId) {
      const { data: loc } = await supabase.from('locations').select('company_id').eq('id', locationId).maybeSingle();
      if (loc?.company_id) seed.company_id = loc.company_id;
    }
    // Pre-linked creation must seed the currency too: the builder's company
    // onChange never fires when the company arrives already chosen, so a US
    // company's invoice would sit in GBP with 20% VAT unless someone noticed.
    if (seed.company_id) {
      const { data: co } = await supabase.from('companies').select('country').eq('id', seed.company_id).maybeSingle();
      seed.currency = currencyForCountry(co?.country);
    }
    const { data, error } = await supabase.from('invoices').insert(seed).select('id').single();
    if (error) { alert(error.message); return; }
    onNavigate?.('invoice', data.id);
  };

  const outstanding = invoices.filter(i => !['paid', 'void', 'draft'].includes(i.status))
    .reduce((acc, i) => { const c = i.currency || 'GBP'; acc[c] = (acc[c] || 0) + Number(i.total || 0); return acc; }, {});
  const outstandingTotal = Object.values(outstanding).reduce((s, v) => s + v, 0);

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <Receipt size={15} className="text-ember" />
        <h3 className="text-sm font-bold text-paper">Invoices</h3>
        <span className="text-xs text-dim font-mono">({invoices.length})</span>
        {recurringCount > 0 && <span className="text-[10px] text-uv flex items-center gap-0.5"><Repeat size={10} /> {recurringCount}</span>}
        {canWrite && <button onClick={newInvoice} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">+ New</button>}
      </div>
      <div className="divide-y divide-bdr">
        {invoices.length === 0 ? (
          <div className="px-4 py-4 text-xs text-dim italic text-center">No invoices yet</div>
        ) : invoices.map(inv => {
          const st = invStatus(inv);
          return (
            <div key={inv.id} onClick={() => onNavigate?.('invoice', inv.id)}
              className="px-4 py-2.5 flex items-center gap-2 hover:bg-card/50 cursor-pointer">
              <span className="font-mono text-[11px] text-dim shrink-0">INV-{inv.invoice_number}</span>
              {inv.recurring_id && <Repeat size={10} className="text-uv shrink-0" />}
              <span className="text-sm text-paper tabular-nums ml-auto shrink-0">{money(inv.total, inv.currency)}</span>
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${INV_BADGE[st]}`}>{st}</span>
            </div>
          );
        })}
        {outstandingTotal > 0 && (
          <div className="px-4 py-2 text-[11px] text-muted flex justify-between">
            <span>Outstanding</span><span className="font-semibold text-paper tabular-nums">{['GBP', 'USD'].filter(c => outstanding[c]).map(c => money(outstanding[c], c)).join(' + ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
