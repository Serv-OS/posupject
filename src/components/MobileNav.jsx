import { useMemo, useState } from 'react';
import { Home, MapPin, Mail, LayoutGrid, Search, X, Pin, History } from 'lucide-react';
import { CORE, COLLAPSIBLE } from './Sidebar.jsx';
import { useStickyState } from '../lib/stickyState';

// Mobile information architecture (screens 15–16).
//
// The sidebar carries 55 destinations. On a phone that is a scrolling list you
// read rather than a menu you use, which is what made the product painful in
// the field. Four fixed tabs cover what people actually open standing up, and
// everything else lives behind More — searchable, so anything is two taps.
//
// Nothing is REMOVED. Parity is the rule: every destination on desktop is
// reachable here, because a field worker hitting a wall has no laptop to fall
// back to. The hub is how 55 things stay reachable without 55 things being
// visible.
//
// Pinned is per person and seeded by role, because what an engineer opens
// standing on a roof is not what an owner opens on the train.

const TABS = [
  ['today', 'Today', Home],
  ['locations', 'Sites', MapPin],
  ['inbox', 'Inbox', Mail],
  ['__more', 'More', LayoutGrid],
];

const SEED_BY_ROLE = {
  owner:  ['work', 'tickets', 'invoices', 'companies', 'deals', 'finance_reports'],
  editor: ['work', 'tickets', 'companies', 'contacts', 'calls', 'projects'],
  viewer: ['tickets', 'companies', 'contacts', 'calendar'],
};

/** Every destination as one flat list — the single source both navs read. */
export function allDestinations() {
  const out = CORE.map(([key, label, Icon]) => ({ key, label, Icon, group: 'Core' }));
  for (const g of COLLAPSIBLE) {
    for (const [key, label, Icon] of g.items) out.push({ key, label, Icon, group: g.label });
  }
  return out;
}

export default function MobileNav({ profile, view, onGo }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pinned, setPinned] = useStickyState(`nav.pinned.${profile?.id || 'anon'}`,
    SEED_BY_ROLE[profile?.role] || SEED_BY_ROLE.viewer);
  const [recents, setRecents] = useStickyState(`nav.recents.${profile?.id || 'anon'}`, []);

  const all = useMemo(allDestinations, []);
  const byKey = useMemo(() => Object.fromEntries(all.map(d => [d.key, d])), [all]);

  const go = (key) => {
    setRecents(r => [key, ...r.filter(x => x !== key)].slice(0, 6));
    setMoreOpen(false); setQ('');
    onGo(key);
  };

  const togglePin = (key) => setPinned(p => (p.includes(key) ? p.filter(x => x !== key) : [...p, key]));

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return null;
    return all.filter(d => d.label.toLowerCase().includes(s) || d.group.toLowerCase().includes(s));
  }, [q, all]);

  const grouped = useMemo(() => {
    const m = new Map();
    for (const d of all) { if (!m.has(d.group)) m.set(d.group, []); m.get(d.group).push(d); }
    return [...m.entries()];
  }, [all]);

  return (
    <>
      {/* The hub. Full screen because a menu you scroll inside a menu is worse
          than the sidebar it replaces. */}
      {moreOpen && (
        <div className="lg:hidden fixed inset-0 z-50 bg-panel flex flex-col" style={{ background: 'var(--scene)' }}>
          <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
            <Search size={16} className="text-dim shrink-0" />
            <input autoFocus value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search all destinations…"
              className="flex-1 bg-transparent text-sm text-paper placeholder-dim focus:outline-none" />
            <button onClick={() => { setMoreOpen(false); setQ(''); }} className="p-1 text-dim hover:text-paper"><X size={18} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {results ? (
              results.length === 0
                ? <div className="py-10 text-center text-sm text-dim">Nothing matches &ldquo;{q}&rdquo;.</div>
                : <div className="space-y-1">
                    {results.map(d => (
                      <button key={d.key} onClick={() => go(d.key)}
                        className="w-full min-h-[48px] px-3 flex items-center gap-3 rounded-xl hover:bg-card text-left">
                        <d.Icon size={17} className="text-dim shrink-0" />
                        <span className="text-sm text-paper flex-1">{d.label}</span>
                        <span className="text-[11px] text-dim">{d.group}</span>
                      </button>
                    ))}
                  </div>
            ) : (
              <>
                <div>
                  <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-2 flex items-center gap-1.5">
                    <Pin size={11} /> Pinned
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {pinned.map(k => byKey[k]).filter(Boolean).map(d => (
                      <button key={d.key} onClick={() => go(d.key)}
                        className="min-h-[76px] p-3 rounded-2xl bg-card border border-bdr flex flex-col items-center justify-center gap-1.5 active:bg-ember/10">
                        <d.Icon size={19} className="text-ember" />
                        <span className="text-[11px] text-paper text-center leading-tight">{d.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {recents.filter(k => byKey[k]).length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-2 flex items-center gap-1.5">
                      <History size={11} /> Recent
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {recents.map(k => byKey[k]).filter(Boolean).map(d => (
                        <button key={d.key} onClick={() => go(d.key)}
                          className="px-3 py-1.5 rounded-xl bg-card border border-bdr text-xs text-paper">{d.label}</button>
                      ))}
                    </div>
                  </div>
                )}

                {grouped.map(([group, items]) => (
                  <div key={group}>
                    <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1.5">{group}</div>
                    <div className="rounded-2xl border border-bdr overflow-hidden">
                      {items.map(d => (
                        <div key={d.key} className="flex items-stretch border-b border-bdr last:border-b-0">
                          <button onClick={() => go(d.key)}
                            className="flex-1 min-h-[48px] px-3 flex items-center gap-3 bg-card active:bg-ember/10 text-left">
                            <d.Icon size={17} className="text-dim shrink-0" />
                            <span className="text-sm text-paper">{d.label}</span>
                          </button>
                          <button onClick={() => togglePin(d.key)} title={pinned.includes(d.key) ? 'Unpin' : 'Pin'}
                            className={`w-11 flex items-center justify-center bg-card ${pinned.includes(d.key) ? 'text-ember' : 'text-dim'}`}>
                            <Pin size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* The bar. 48px rows and a safe-area inset so it clears the home bar. */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-bdr flex"
        style={{ background: 'var(--scene)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {TABS.map(([key, label, Icon]) => {
          const active = key === '__more' ? moreOpen : (!moreOpen && view === key);
          return (
            <button key={key}
              onClick={() => (key === '__more' ? setMoreOpen(v => !v) : go(key))}
              className={`flex-1 min-h-[56px] flex flex-col items-center justify-center gap-0.5 ${active ? 'text-ember' : 'text-dim'}`}>
              <Icon size={19} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
