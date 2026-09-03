import { useEffect, useRef, useState } from 'react';

// One field, edited in place.
//
// The old task page had an edit MODE: a button that swapped the whole record
// for a form, so changing a due date meant entering edit, finding the field,
// saving, and leaving. Four steps to move a date one day.
//
// A chip is the value and the control at once. Click it, pick, done — one
// write, no mode, and the rest of the page never stops being readable. Which
// is also why status changes stopped being fiddly on every other screen.

export default function FieldChip({ label, value, options, onPick, tone = 'default', disabled, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const tones = {
    default: 'bg-card border-bdr text-paper',
    muted: 'bg-card border-bdr text-muted',
    ember: 'bg-ember/10 border-ember/25 text-ember-deep',
    amber: 'bg-amber/15 border-amber/30 text-amber',
    red: 'bg-red-100 border-red-200 text-red-700',
    green: 'bg-emerald-100 border-emerald-200 text-emerald-700',
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        onClick={() => !disabled && setOpen(v => !v)}
        disabled={disabled}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-medium transition
          ${tones[tone] || tones.default} ${disabled ? 'opacity-60 cursor-default' : 'hover:border-ember/40'}`}>
        <span className="text-[9px] font-mono uppercase tracking-wider opacity-60">{label}</span>
        <span>{value ?? '—'}</span>
      </button>

      {open && (
        // menu-surface, not glass: a popover inside a glass card cannot rely on
        // backdrop-filter and comes out see-through.
        <div className="absolute z-40 mt-1 min-w-[180px] max-h-72 overflow-y-auto menu-surface rounded-xl py-1">
          {children
            ? <div className="p-2">{children}</div>
            : options.map(o => (
                <button key={o.value ?? o.label}
                  onClick={() => { onPick(o.value); setOpen(false); }}
                  className="w-full px-3 py-2 text-left text-sm text-paper hover:bg-ember/10 flex items-center justify-between gap-3">
                  <span>{o.label}</span>
                  {o.hint && <span className="text-[10px] text-dim shrink-0">{o.hint}</span>}
                </button>
              ))}
        </div>
      )}
    </div>
  );
}
