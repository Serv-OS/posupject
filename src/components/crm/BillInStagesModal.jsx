import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus } from 'lucide-react';
import { STAGE_PRESETS, MAX_STAGES, stagesProblem, stageLines } from '../../lib/invoiceStages';
import { invoiceTotals } from '../../lib/invoiceLines';

// Pick the stages (name and percentage each) and see what every stage will
// charge before anything is written. onSplit does the writing.
export default function BillInStagesModal({ invoiceLabel, lines, fmt, onClose, onSplit }) {
  const [stages, setStages] = useState(STAGE_PRESETS[1].stages.map(s => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const problem = stagesProblem(stages);
  const preview = problem ? [] : stageLines(lines, stages, fmt).map(st => invoiceTotals(st).total);
  const sum = stages.reduce((a, s) => a + (Number(s.percent) || 0), 0);

  const setStage = (i, k, v) => setStages(p => p.map((s, j) => j === i ? { ...s, [k]: v } : s));
  const go = async () => {
    if (problem || busy) return;
    setBusy(true);
    const ok = await onSplit(stages.map(s => ({ label: s.label.trim(), percent: Number(s.percent) })));
    setBusy(false);
    if (ok) onClose();
  };

  const input = 'bg-card border border-bdr rounded-lg px-2.5 py-1.5 text-sm text-paper';
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-stretch sm:items-center justify-center sm:p-6"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose?.()}>
      <div role="dialog" aria-modal="true" aria-label="Bill in stages"
        style={{ background: 'var(--scene)' }}
        className="sm:rounded-2xl shadow-2xl w-full sm:max-w-md flex flex-col max-h-full sm:max-h-[92vh] min-h-0">
        <div className="px-4 sm:px-5 py-3 border-b border-bdr flex items-center gap-3 shrink-0">
          <div className="min-w-0">
            <div className="text-base font-bold text-paper">Bill in stages</div>
            <div className="text-[11px] text-muted">{invoiceLabel} becomes stage 1. The other stages are new draft invoices to send when due.</div>
          </div>
          <button onClick={onClose} disabled={busy} className="ml-auto text-muted hover:text-paper"><X size={18} /></button>
        </div>

        <div className="px-4 sm:px-5 py-4 space-y-3 overflow-y-auto min-h-0">
          <div className="flex flex-wrap gap-1.5">
            {STAGE_PRESETS.map(p => (
              <button key={p.name} type="button" onClick={() => setStages(p.stages.map(s => ({ ...s })))}
                className="btn-ghost px-2.5 py-1 rounded-lg text-xs">{p.name}</button>
            ))}
          </div>

          {stages.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-dim w-5 shrink-0">{i + 1}.</span>
              <input className={input + ' flex-1 min-w-0'} value={s.label} placeholder="Stage name"
                onChange={e => setStage(i, 'label', e.target.value)} />
              <input className={input + ' w-16 text-right'} inputMode="decimal" value={s.percent}
                onChange={e => setStage(i, 'percent', e.target.value)} />
              <span className="text-sm text-muted">%</span>
              <span className="w-24 text-right text-sm tabular-nums text-paper shrink-0">{preview[i] != null ? fmt(preview[i]) : ''}</span>
              <button type="button" onClick={() => setStages(p => p.filter((_, j) => j !== i))} disabled={stages.length <= 2}
                title="Remove stage" className="text-red-500 hover:text-red-600 text-sm disabled:opacity-30">&times;</button>
            </div>
          ))}

          {stages.length < MAX_STAGES && (
            <button type="button" onClick={() => setStages(p => [...p, { label: '', percent: Math.max(0, Math.round((100 - sum) * 100) / 100) }])}
              className="text-xs text-ember hover:text-ember-deep font-medium flex items-center gap-1"><Plus size={13} /> Add stage</button>
          )}

          <div className={`text-xs ${problem ? 'text-red-600' : 'text-muted'}`}>
            {problem || 'Amounts include VAT. Each stage gets its own invoice number and pay link.'}
          </div>
        </div>

        <div className="px-4 sm:px-5 py-3 border-t border-bdr flex items-center gap-2 shrink-0">
          <button onClick={go} disabled={!!problem || busy}
            className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50">
            {busy ? 'Splitting…' : `Split into ${stages.length} invoices`}
          </button>
          <button onClick={onClose} disabled={busy} className="btn-ghost px-3 py-2 rounded-xl text-sm">Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
