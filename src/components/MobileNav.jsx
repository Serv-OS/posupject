import { useEffect, useMemo, useRef, useState } from 'react';
import { Home, MapPin, Mail, LayoutGrid, Search, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { CORE, COLLAPSIBLE } from './Sidebar.jsx';
import { useStickyState } from '../lib/stickyState';

// Mobile information architecture (screens 15–16).
//
// Four fixed tabs cover what people open standing up — Today, Sites, Inbox,
// More — and everything else lives behind More: a search over the whole
// catalogue, a Pinned grid seeded by role, Recents, then every section as a
// row with a count. Two taps to anything. Nothing is removed: parity is the
// rule, because someone hitting a wall on a roof has no laptop to fall back on.

const TABS = [['today', 'Today', Home], ['locations', 'Sites', MapPin], ['inbox', 'Inbox', Mail], ['__more', 'More', LayoutGrid]];
const SEED_BY_ROLE = {
  owner:  ['tickets', 'onboarding', 'calls', 'invoices', 'companies', 'finance_reports'],
  editor: ['tickets', 'onboarding', 'calls', 'companies', 'contacts', 'projects'],
  viewer: ['tickets', 'companies', 'contacts', 'calendar'],
};

export function allDestinations() {
  const out = CORE.map(([key, label, Icon]) => ({ key, label, Icon, group: 'Work' }));
  for (const g of COLLAPSIBLE) for (const [key, label, Icon] of g.items) out.push({ key, label, Icon, group: g.label });
  return out;
}

export default function MobileNav({ profile, view, onGo }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [q, setQ] = useState('');
  const [unread, setUnread] = useState(0);
  const [pinned, setPinned] = useStickyState(`nav.pinned.${profile?.id || 'anon'}`, SEED_BY_ROLE[profile?.role] || SEED_BY_ROLE.viewer);
  const [recents, setRecents] = useStickyState(`nav.recents.${profile?.id || 'anon'}`, []);
  const [openSection, setOpenSection] = useState(null);

  const all = useMemo(allDestinations, []);
  const byKey = useMemo(() => Object.fromEntries(all.map(d => [d.key, d])), [all]);
  const sections = useMemo(() => COLLAPSIBLE.map(g => ({ id: g.id, label: g.label, items: g.items.filter(([, , , need]) => !need || profile?.role === need), sample: g.items.slice(0, 3).map(i => i[1]).join(', ') })), [profile?.role]);

  // The Inbox badge: notifications you have not read.
  useEffect(() => {
    if (!profile?.id) return;
    const load = () => supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', profile.id).is('read_at', null).then(r => setUnread(r.count || 0));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [profile?.id]);

  const go = (key) => { setRecents(r => [key, ...r.filter(x => x !== key)].slice(0, 6)); setMoreOpen(false); setQ(''); setOpenSection(null); onGo(key); };
  const togglePin = (key) => setPinned(p => (p.includes(key) ? p.filter(x => x !== key) : [...p, key]));
  const results = useMemo(() => { const s = q.trim().toLowerCase(); if (!s) return null; return all.filter(d => d.label.toLowerCase().includes(s) || d.group.toLowerCase().includes(s)); }, [q, all]);

  // Hold to pin: a long press on any row.
  // Hold to pin. The long press has to swallow the click that follows it, or the
  // hub navigates away and closes before anyone sees the pin land.
  const longRef = useRef(false);
  const press = (key) => {
    let t; return {
      onTouchStart: () => { longRef.current = false; t = setTimeout(() => { longRef.current = true; togglePin(key); if (navigator.vibrate) navigator.vibrate(10); }, 550); },
      onTouchEnd: () => clearTimeout(t), onTouchMove: () => clearTimeout(t), onTouchCancel: () => clearTimeout(t),
      onContextMenu: (e) => e.preventDefault(),
    };
  };
  const guard = (fn) => (e) => { if (longRef.current) { longRef.current = false; e.preventDefault(); return; } fn(); };

  return (
    <>
      {moreOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex flex-col" style={{ background: 'var(--scene-bg)' }}>
          <div className="px-[18px] pt-3 pb-3">
            <div className="flex items-center justify-between">
              <div className="font-display text-[23px] font-extrabold text-paper">More</div>
              <button onClick={() => { setMoreOpen(false); setQ(''); }} className="p-1 text-dim hover:text-paper"><X size={20} /></button>
            </div>
            <div className="mt-2.5 flex items-center gap-2.5 px-[15px] py-[13px] rounded-[12px] border" style={{ background: 'var(--surface-solid)', borderColor: 'var(--ink-line)' }}>
              <Search size={16} className="text-dim shrink-0" />
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search the whole system…" className="flex-1 min-w-0 bg-transparent text-[15px] text-paper placeholder-dim focus:outline-none" />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-[14px] flex flex-col gap-[14px] [&>*]:shrink-0" style={{ paddingBottom: 'calc(var(--tabbar-h) + env(safe-area-inset-bottom))' }}>
            {results ? (
              <div className="rounded-[16px] border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-card)' }}>
                {results.length === 0 && <div className="px-[15px] py-6 text-center text-[14px] text-dim">Nothing matches “{q}”.</div>}
                {results.map((d, i) => (
                  <button key={d.key} onClick={guard(() => go(d.key))} {...press(d.key)} className={`w-full min-h-[48px] px-[15px] flex items-center gap-2.5 text-left ${i < results.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)' }}>
                    <d.Icon size={17} className="text-dim shrink-0" /><span className="text-[15px] text-paper flex-1">{d.label}</span><span className="text-[11px] text-dim">{d.group}</span>
                  </button>
                ))}
              </div>
            ) : openSection ? (
              <div>
                <button onClick={() => setOpenSection(null)} className="text-[13px] text-dim mb-2">&larr; All sections</button>
                <div className="rounded-[16px] border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-card)' }}>
                  {sections.find(s => s.id === openSection)?.items.map(([key, label, Icon], i, arr) => (
                    <button key={key} onClick={guard(() => go(key))} {...press(key)} className={`w-full min-h-[48px] px-[15px] flex items-center gap-2.5 text-left ${i < arr.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)' }}>
                      <Icon size={17} className="text-dim shrink-0" /><span className="text-[15px] text-paper flex-1">{label}</span>
                      {pinned.includes(key) && <span className="text-[11px]" style={{ color: 'rgb(var(--c-primary-deep))' }}>pinned</span>}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div>
                  <div className="font-mono text-[10px] font-bold tracking-[.18em] uppercase text-dim px-1.5 pb-2">Pinned — hold any row to pin it here</div>
                  <div className="grid gap-[9px]" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
                    {pinned.map(k => byKey[k]).filter(Boolean).map(d => (
                      <button key={d.key} onClick={guard(() => go(d.key))} {...press(d.key)} className="rounded-[14px] border px-2.5 py-[14px] flex flex-col items-center justify-center gap-[7px] active:opacity-80"
                        style={{ background: 'var(--card-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-card)' }}>
                        <span className="w-5 h-5 rounded-[6px] flex items-center justify-center" style={{ background: 'rgb(var(--c-primary) / .35)' }}><d.Icon size={13} /></span>
                        <span className="text-[12px] font-semibold text-paper text-center leading-tight">{d.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {recents.filter(k => byKey[k]).length > 0 && (
                  <div>
                    <div className="font-mono text-[10px] font-bold tracking-[.18em] uppercase text-dim px-1.5 pb-2">Recent</div>
                    <div className="rounded-[16px] border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-card)' }}>
                      {recents.map(k => byKey[k]).filter(Boolean).map((d, i, arr) => (
                        <button key={d.key} onClick={guard(() => go(d.key))} {...press(d.key)} className={`w-full px-[15px] py-[13px] flex items-center gap-2.5 text-left text-[15px] text-paper ${i < arr.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)' }}>
                          {d.label}<span className="text-[11px] text-dim">{d.group}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div>
                  <div className="font-mono text-[10px] font-bold tracking-[.18em] uppercase text-dim px-1.5 pb-2">All sections</div>
                  <div className="rounded-[16px] border overflow-hidden" style={{ background: 'var(--card-bg)', borderColor: 'var(--bdr)', boxShadow: 'var(--shadow-card)' }}>
                    {sections.map((s, i) => (
                      <button key={s.id} onClick={() => setOpenSection(s.id)} className={`w-full px-[15px] py-[14px] flex items-center gap-2.5 text-left ${i < sections.length - 1 ? 'border-b' : ''}`} style={{ borderColor: 'var(--hair)' }}>
                        <span className="text-[15px] font-medium text-paper">{s.label}</span>
                        <span className="text-[12px] text-dim ml-auto truncate max-w-[55%]">{s.sample} · {s.items.length}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* The bar: 4 tabs, 22px marks, 11px labels, coral badge on Inbox. */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t grid"
        style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', background: 'var(--panel-bg)', backdropFilter: 'blur(12px)', borderColor: 'var(--hair)', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {TABS.map(([key, label, Icon]) => {
          const active = key === '__more' ? moreOpen : (!moreOpen && (view === key || (key === 'locations' && view === 'location_detail')));
          return (
            <button key={key} onClick={() => (key === '__more' ? setMoreOpen(v => !v) : go(key))} className="relative min-h-[56px] pt-[11px] pb-[8px] flex flex-col items-center gap-[5px]">
              <span className="w-[22px] h-[22px] rounded-[7px] flex items-center justify-center" style={{ background: active ? 'rgb(var(--c-primary))' : 'var(--ink-line)', color: active ? 'rgb(var(--c-ink))' : 'rgb(var(--c-muted))' }}>
                <Icon size={14} />
              </span>
              {key === 'inbox' && unread > 0 && (
                <span className="absolute top-[7px] left-[calc(50%+6px)] min-w-[16px] h-4 rounded-full px-1 text-[10px] font-bold flex items-center justify-center" style={{ background: 'rgb(var(--c-coral))', color: 'var(--on-accent)' }}>{unread}</span>
              )}
              <span className="text-[11px]" style={{ color: active ? 'rgb(var(--c-text))' : 'rgb(var(--c-muted))', fontWeight: active ? 600 : 400 }}>{label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
