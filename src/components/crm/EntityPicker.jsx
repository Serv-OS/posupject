import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';

// Live type-ahead picker over a Supabase table. Searches the WHOLE table as you
// type (not a preloaded page, so it scales to thousands of rows) and calls
// onPick(row) when a result is chosen. Used to link companies/locations, etc.
export default function EntityPicker({
  table, searchCols, labelOf, subOf, onPick, exclude, placeholder, autoFocus = true,
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = q.replace(/[,()%*]/g, ' ').trim();
    if (s.length < 1) { setResults([]); setBusy(false); return; }
    setBusy(true);
    const filter = searchCols.map(c => `${c}.ilike.%${s}%`).join(',');
    const h = setTimeout(async () => {
      const { data } = await supabase.from(table).select('*').or(filter).limit(20);
      setResults((data || []).filter(r => !exclude?.has(r.id)));
      setBusy(false);
    }, 200);
    return () => clearTimeout(h);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  return (
    <div>
      <input autoFocus={autoFocus} value={q} onChange={e => setQ(e.target.value)} placeholder={placeholder} className={input} />
      {results.length > 0 && (
        <div className="mt-1 max-h-52 overflow-y-auto border border-bdr rounded-lg divide-y divide-bdr">
          {results.map(r => (
            <button key={r.id} type="button" onClick={() => { onPick(r); setQ(''); setResults([]); }}
              className="w-full text-left px-3 py-2 hover:bg-ember/10 transition">
              <div className="text-sm text-paper truncate">{labelOf(r)}</div>
              {subOf && subOf(r) && <div className="text-xs text-dim truncate">{subOf(r)}</div>}
            </button>
          ))}
        </div>
      )}
      {q.trim().length >= 1 && !busy && results.length === 0 && (
        <div className="text-xs text-dim italic px-1 py-1.5">No matches — keep typing.</div>
      )}
    </div>
  );
}
