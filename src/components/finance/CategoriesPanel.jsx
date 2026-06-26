import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase';
import { Tags, Plus, X, Trash2 } from 'lucide-react';

const TREATMENTS = ['standard', 'reduced', 'zero', 'exempt', 'no_vat'];
const TREAT_LABEL = { standard: 'Standard 20%', reduced: 'Reduced 5%', zero: 'Zero 0%', exempt: 'Exempt', no_vat: 'No VAT' };

export default function CategoriesPanel({ profile }) {
  const [cats, setCats] = useState([]);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase.from('expense_categories').select('*').order('sort');
    setCats(data || []); setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <Tags size={20} className="text-ember" />
          <div>
            <div className="text-xl font-bold text-paper">Expense categories</div>
            <div className="text-xs text-muted">Chart of accounts + default VAT treatment for bills & expenses</div>
          </div>
        </div>
        {canWrite && <button onClick={() => setEditing({})} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Plus size={15} /> New category</button>}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto glass-card rounded-2xl overflow-hidden">
          <div className="px-5 py-2.5 border-b border-bdr grid grid-cols-12 gap-2 text-[10px] font-mono font-bold uppercase tracking-[0.12em] text-dim">
            <span className="col-span-4">Category</span><span className="col-span-3">VAT treatment</span>
            <span className="col-span-2 text-right">Rate</span><span className="col-span-2 text-center">Reclaim</span><span className="col-span-1 text-right">Nominal</span>
          </div>
          {loading ? <div className="p-6 text-center text-dim text-sm">Loading…</div>
            : cats.map(c => (
              <div key={c.id} onClick={() => canWrite && setEditing(c)}
                className={`px-5 py-3 grid grid-cols-12 gap-2 items-center border-b border-bdr/60 last:border-0 ${canWrite ? 'hover:bg-card/50 cursor-pointer' : ''} ${!c.active ? 'opacity-50' : ''}`}>
                <span className="col-span-4 text-sm text-paper font-medium">{c.label}</span>
                <span className="col-span-3 text-xs text-muted">{TREAT_LABEL[c.vat_treatment] || c.vat_treatment}</span>
                <span className="col-span-2 text-right text-xs tabular-nums text-muted">{c.default_tax_rate != null ? `${c.default_tax_rate}%` : '—'}</span>
                <span className="col-span-2 text-center text-xs">{c.reclaimable ? <span className="text-emerald-600">✓</span> : <span className="text-red-500">blocked</span>}</span>
                <span className="col-span-1 text-right text-[11px] font-mono text-dim">{c.nominal_code || '—'}</span>
              </div>
            ))}
        </div>
      </div>

      {editing && <CategoryModal cat={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function CategoryModal({ cat, onClose, onSaved }) {
  const c = cat || {};
  const [f, setF] = useState({
    code: c.code || '', label: c.label || '', vat_treatment: c.vat_treatment || 'standard',
    default_tax_rate: c.default_tax_rate ?? 20, reclaimable: c.reclaimable ?? true,
    nominal_code: c.nominal_code || '', sort: c.sort ?? 100, active: c.active ?? true,
  });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const num = (v) => v === '' || v == null ? null : Number(v);

  const save = async () => {
    if (!f.label.trim()) { alert('Label required'); return; }
    const row = {
      code: (f.code.trim() || f.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')).slice(0, 40),
      label: f.label.trim(), vat_treatment: f.vat_treatment, default_tax_rate: num(f.default_tax_rate),
      reclaimable: !!f.reclaimable, nominal_code: f.nominal_code.trim() || null,
      sort: Number(f.sort) || 100, active: !!f.active, updated_at: new Date().toISOString(),
    };
    const { error } = c.id
      ? await supabase.from('expense_categories').update(row).eq('id', c.id)
      : await supabase.from('expense_categories').insert(row);
    if (error) { alert(error.message); return; }
    onSaved();
  };
  const del = async () => {
    if (!confirm('Delete this category? Bills/expenses using it keep their stored figures.')) return;
    const { error } = await supabase.from('expense_categories').delete().eq('id', c.id);
    if (error) { alert(error.message); return; }
    onSaved();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-card rounded-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-bdr flex items-center justify-between">
          <div className="text-base font-bold text-paper">{c.id ? 'Edit category' : 'New category'}</div>
          <button onClick={onClose} className="text-muted hover:text-paper"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>Label</label><input className={input} value={f.label} onChange={e => set('label', e.target.value)} placeholder="Travel" /></div>
            <div><label className={label}>Nominal code</label><input className={input} value={f.nominal_code} onChange={e => set('nominal_code', e.target.value)} placeholder="optional" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={label}>VAT treatment</label>
              <select className={input} value={f.vat_treatment} onChange={e => set('vat_treatment', e.target.value)}>
                {TREATMENTS.map(t => <option key={t} value={t}>{TREAT_LABEL[t]}</option>)}</select></div>
            <div><label className={label}>Default rate %</label><input type="number" className={input} value={f.default_tax_rate ?? ''} onChange={e => set('default_tax_rate', e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-5">
            <button type="button" onClick={() => set('reclaimable', !f.reclaimable)} className="flex items-center gap-2 text-sm text-paper">
              <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${f.reclaimable ? 'bg-ember border-ember text-white' : 'border-bdr'}`}>{f.reclaimable ? '✓' : ''}</span>Input VAT reclaimable</button>
            <button type="button" onClick={() => set('active', !f.active)} className="flex items-center gap-2 text-sm text-paper">
              <span className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${f.active ? 'bg-ember border-ember text-white' : 'border-bdr'}`}>{f.active ? '✓' : ''}</span>Active</button>
            <div className="ml-auto"><label className={label}>Sort</label><input type="number" className={input + ' !w-20'} value={f.sort} onChange={e => set('sort', e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button onClick={save} className="btn-glass px-5 py-2 rounded-xl text-sm font-semibold">Save</button>
            <button onClick={onClose} className="btn-ghost px-4 py-2 rounded-xl text-sm">Cancel</button>
            {c.id && <button onClick={del} className="ml-auto text-red-600 hover:bg-red-50 p-2 rounded-xl"><Trash2 size={16} /></button>}
          </div>
        </div>
      </div>
    </div>
  );
}
