import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';

const TYPE_ICON = {
  assignment: '\u{1F4CC}', // pushpin
  mention: '\u{1F4AC}',    // speech balloon
  reply: '\u{2709}',       // envelope
  system: '\u{1F514}',     // bell
};

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function NotificationBell({ profile, onNavigate }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    load();
    const ch = supabase.channel('notifications-' + profile.id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${profile.id}` },
        load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile.id]);

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const load = async () => {
    const { data } = await supabase.from('notifications')
      .select('*').eq('recipient_id', profile.id)
      .order('created_at', { ascending: false }).limit(40);
    setItems(data || []);
  };

  const unread = items.filter(i => !i.read_at).length;

  const openItem = async (n) => {
    if (!n.read_at) {
      await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', n.id);
    }
    setOpen(false);
    if (n.entity_type && n.link_id) onNavigate?.(n.entity_type, n.link_id);
    load();
  };

  const markAll = async () => {
    await supabase.from('notifications').update({ read_at: new Date().toISOString() })
      .eq('recipient_id', profile.id).is('read_at', null);
    load();
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)}
        className="relative w-9 h-9 rounded-xl flex items-center justify-center hover:bg-card transition"
        title="Notifications">
        <span className="text-lg">{'\u{1F514}'}</span>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-pop absolute right-0 top-full mt-2 w-[min(20rem,calc(100vw-1.5rem))] max-h-[70vh] overflow-y-auto glass-card rounded-2xl shadow-xl z-50">
          <div className="px-4 py-3 border-b border-bdr flex items-center justify-between sticky top-0 glass-card">
            <div className="text-sm font-bold text-paper">Notifications</div>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-ember hover:text-ember-deep font-medium">Mark all read</button>
            )}
          </div>

          {items.length === 0 ? (
            <div className="px-4 py-10 text-center text-dim text-sm">
              <div className="text-2xl mb-1">{'\u{1F514}'}</div>
              You're all caught up
            </div>
          ) : (
            items.map(n => (
              <button key={n.id} onClick={() => openItem(n)}
                className={`w-full px-4 py-3 text-left border-b border-bdr last:border-b-0 hover:bg-card/50 transition flex gap-2.5 ${!n.read_at ? 'bg-ember/5' : ''}`}>
                <span className="text-base shrink-0 mt-0.5">{TYPE_ICON[n.type] || TYPE_ICON.system}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-paper leading-snug">{n.title}</div>
                  {n.body && <div className="text-xs text-muted truncate">{n.body}</div>}
                  <div className="text-[10px] text-dim mt-0.5">{timeAgo(n.created_at)}</div>
                </div>
                {!n.read_at && <span className="w-2 h-2 rounded-full bg-ember shrink-0 mt-1.5" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
