import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { pending, remove, flush, isOnline, runOrQueue } from '../../lib/offlineQueue';
import { useStickyState } from '../../lib/stickyState';
import InboxPanel from './InboxPanel.jsx';
import { Card, Pill, Mono, PrimaryBtn, GhostBtn, Segmented, SkeletonList, OfflineBanner, fmtRel } from './ui.jsx';

// The phone Inbox (screen 18): what needs you, what you have read, and anything
// written while offline that is still waiting to send. Approvals come from the
// work layer (expenses awaiting sign-off); everything else is a notification.

const KIND = {
  approval:   { label: 'Approval', tone: 'amber' },
  mention:    { label: 'Mention', tone: 'primary' },
  reply:      { label: 'Reply', tone: 'uv' },
  assignment: { label: 'Assigned', tone: 'ink' },
  system:     { label: 'System', tone: 'muted' },
};

export default function MobileInbox({ profile, onNavigate }) {
  // Tapping Inbox lands on the shared mailbox, the way it always has. The
  // notifications, approvals and the offline queue sit behind the second tab.
  const [tab, setTab] = useStickyState('inbox.tab', 'mail');
  const [items, setItems] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [queue, setQueue] = useState(pending());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const approver = profile?.role === 'owner' || profile?.role === 'editor';

  const load = async () => {
    const [n, a] = await Promise.all([
      supabase.from('notifications').select('id, type, title, body, entity_type, link_id, read_at, created_at').eq('recipient_id', profile.id).order('created_at', { ascending: false }).limit(60),
      approver ? supabase.from('work_items').select('*').eq('type', 'approval').order('updated_at', { ascending: false }).limit(30) : Promise.resolve({ data: [] }),
    ]);
    setItems(n.data || []); setApprovals(a.data || []); setLoading(false);
  };
  useEffect(() => { load(); }, [profile.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const f = () => setQueue(pending());
    window.addEventListener('offline-queue-changed', f);
    return () => window.removeEventListener('offline-queue-changed', f);
  }, []);

  const open = async (n) => {
    if (!n.read_at) {
      setItems(l => l.map(x => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      await runOrQueue(supabase, 'Mark read', { table: 'notifications', kind: 'update', values: { read_at: new Date().toISOString() }, match: { id: n.id } });
    }
    if (n.entity_type && n.link_id) onNavigate?.(n.entity_type, n.link_id);
  };
  const decide = async (w, status) => {
    setBusy(w.source_id);
    const r = await runOrQueue(supabase, `${status === 'approved' ? 'Approve' : 'Decline'} — ${w.title}`, { table: w.source_table, kind: 'update', values: { status }, match: { id: w.source_id } });
    setBusy(null);
    if (!r.error) setApprovals(l => l.filter(x => x.source_id !== w.source_id));
  };
  const retry = async () => { await flush(supabase); setQueue(pending()); };

  const needYou = items.filter(i => !i.read_at);
  const read = items.filter(i => i.read_at);
  const needCount = needYou.length + approvals.length;

  const Row = ({ kind, when, title, body, edge, children, onClick }) => (
    <div onClick={onClick} className="px-[15px] py-[13px] border-b last:border-b-0" style={{ borderColor: 'var(--hair)', borderLeft: edge ? '3px solid rgb(var(--c-primary))' : '3px solid transparent' }}>
      <div className="flex items-center gap-2">
        <Pill tone={KIND[kind]?.tone || 'muted'}>{KIND[kind]?.label || kind}</Pill>
        <Mono>{when}</Mono>
      </div>
      <div className="text-[15px] font-medium text-paper mt-1">{title}</div>
      {body && <div className="text-[13px] text-muted mt-0.5 line-clamp-2">{body}</div>}
      {children}
    </div>
  );

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--scene-bg)' }}>
      <OfflineBanner />
      <div className="px-[18px] pt-[14px] pb-2.5">
        <div className="font-display text-[23px] font-extrabold text-paper">Inbox</div>
        <Mono className="!tracking-[.18em] uppercase">{tab === 'mail' ? 'Shared mailbox' : `${needCount} need you · ${read.length} read`}</Mono>
        <div className="mt-2.5">
          <Segmented value={tab} options={[['mail', 'Mail'], ['alerts', `Needs you${needCount ? ` ${needCount}` : ''}`]]} onChange={setTab} />
        </div>
      </div>
      {tab === 'mail' && <div className="flex-1 min-h-0"><InboxPanel profile={profile} onNavigate={onNavigate} /></div>}
      {tab === 'alerts' && (
      <div className="flex-1 overflow-y-auto px-[14px] pb-[calc(70px+env(safe-area-inset-bottom))] flex flex-col gap-3">
        {loading ? <SkeletonList rows={4} /> : (
          <>
            {(approvals.length > 0 || needYou.length > 0) && (
              <Card>
                {approvals.map(w => (
                  <Row key={w.source_id} kind="approval" when={fmtRel(w.updated_at)} title={w.title} body={w.subtitle} edge>
                    <div className="flex gap-2 mt-2.5">
                      <PrimaryBtn small className="flex-1 justify-center !py-[11px]" onClick={() => decide(w, 'approved')} disabled={busy === w.source_id}>Approve</PrimaryBtn>
                      <GhostBtn className="flex-1 justify-center !py-[11px]" onClick={() => decide(w, 'rejected')} disabled={busy === w.source_id}>Decline</GhostBtn>
                    </div>
                  </Row>
                ))}
                {needYou.map(n => <Row key={n.id} kind={n.type} when={fmtRel(n.created_at)} title={n.title} body={n.body} edge onClick={() => open(n)} />)}
              </Card>
            )}
            {!approvals.length && !needYou.length && (
              <Card className="px-4 py-6 text-center"><div className="text-[15px] font-semibold text-paper">Nothing needs you.</div><div className="text-[13px] text-muted mt-0.5">Mentions, replies and approvals land here.</div></Card>
            )}
            {queue.length > 0 && (
              <Card>
                <div className="px-[15px] py-2.5 border-b flex items-center gap-2" style={{ borderColor: 'var(--hair)' }}>
                  <span className="text-[14px] font-bold text-paper">Queued while offline</span>
                  <Mono>{queue.length}</Mono>
                  {isOnline() && <button onClick={retry} className="ml-auto text-[12px] font-semibold" style={{ color: 'rgb(var(--c-primary-deep))' }}>Retry</button>}
                </div>
                {queue.map(q => (
                  <div key={q.id} className="px-[15px] py-[11px] border-b last:border-b-0 flex items-center gap-2.5" style={{ borderColor: 'var(--hair)' }}>
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] text-paper truncate">{q.label}</div>
                      {q.error && <div className="text-[11px] truncate" style={{ color: 'rgb(var(--c-coral-deep))' }}>{q.error}</div>}
                    </div>
                    <Mono tone={q.error ? 'coral' : 'amber'} bold>{q.error ? 'failed' : 'pending'}</Mono>
                    {q.error && <button onClick={() => remove(q.id)} className="text-[12px] text-dim">Discard</button>}
                  </div>
                ))}
              </Card>
            )}
            {read.length > 0 && (
              <Card>
                <div className="px-[15px] py-2.5 border-b font-mono text-[9px] font-bold tracking-[.18em] uppercase text-dim" style={{ borderColor: 'var(--hair)' }}>Read</div>
                {read.slice(0, 20).map(n => <Row key={n.id} kind={n.type} when={fmtRel(n.created_at)} title={n.title} body={n.body} onClick={() => open(n)} />)}
              </Card>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}
