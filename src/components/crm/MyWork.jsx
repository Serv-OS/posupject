import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import SlaBadge from './SlaBadge.jsx';
import { LEAD_STAGE_MAP } from '../../lib/leadStages';
import { fmtMoney0 } from '../../lib/money';

const DEAL_OPEN = (s) => !['closed_won', 'closed_lost'].includes(s);
const TICKET_OPEN = (s) => !['resolved', 'closed'].includes(s);

export default function MyWork({ profile, onNavigate }) {
  const [tickets, setTickets] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [deals, setDeals] = useState([]);
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
    const ch = supabase.channel('mywork')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tickets', filter: `owner_id=eq.${profile.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `owner_id=eq.${profile.id}` }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile.id]);

  const load = async () => {
    setLoading(true);
    const [t, tk, d, l] = await Promise.all([
      supabase.from('tickets').select('*').eq('owner_id', profile.id).order('created_at', { ascending: false }),
      supabase.from('tasks').select('*').eq('owner_id', profile.id).order('due_date', { ascending: true, nullsFirst: false }),
      supabase.from('deals').select('*').eq('owner_id', profile.id).order('updated_at', { ascending: false }),
      supabase.from('leads').select('*').eq('owner_id', profile.id).order('created_at', { ascending: false }),
    ]);
    setTickets((t.data || []).filter(x => TICKET_OPEN(x.stage)));
    setTasks((tk.data || []).filter(x => x.status !== 'done'));
    setDeals((d.data || []).filter(x => DEAL_OPEN(x.stage)));
    setLeads((l.data || []).filter(x => !['deal', 'disqualified'].includes(x.stage)));
    setLoading(false);
  };

  const firstName = (profile.display_name || profile.email.split('@')[0]).split(' ')[0];
  const greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  })();

  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  const isOverdue = (d) => d && new Date(d) < new Date(new Date().toDateString());

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-5 border-b border-bdr">
        <div className="text-xl font-bold text-paper">{greeting}, {firstName}</div>
        <div className="text-[10px] text-dim font-mono uppercase tracking-[0.18em]">
          {tickets.length} tickets / {tasks.length} tasks / {deals.length} deals / {leads.length} leads
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="text-dim text-sm text-center py-12">Loading your work…</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-5xl">

            {/* Tickets */}
            <Section title="My open tickets" count={tickets.length} onAll={() => onNavigate('ticket_list')}>
              {tickets.length === 0 ? <Empty>No open tickets</Empty> : tickets.slice(0, 8).map(t => (
                <Row key={t.id} onClick={() => onNavigate('ticket', t.id)}>
                  <span className="text-[10px] font-mono font-bold text-ember shrink-0">#{t.ticket_number}</span>
                  <span className="text-sm text-paper truncate flex-1">{t.subject}</span>
                  <SlaBadge ticket={t} />
                </Row>
              ))}
            </Section>

            {/* Tasks */}
            <Section title="My tasks" count={tasks.length} onAll={() => onNavigate('task_list')}>
              {tasks.length === 0 ? <Empty>No open tasks</Empty> : tasks.slice(0, 8).map(t => (
                <Row key={t.id} onClick={() => onNavigate('task', t.id)}>
                  <span className="text-sm text-paper truncate flex-1">{t.title}</span>
                  {t.due_date && (
                    <span className={`text-[10px] shrink-0 ${isOverdue(t.due_date) ? 'text-red-600 font-bold' : 'text-dim'}`}>
                      {isOverdue(t.due_date) ? 'Overdue · ' : ''}{fmtDate(t.due_date)}
                    </span>
                  )}
                </Row>
              ))}
            </Section>

            {/* Deals: owner-scoped, not region-scoped, so a rep can hold GBP and USD deals
                side by side. Format each row with its own currency, never a fixed £. */}
            <Section title="My open deals" count={deals.length} onAll={() => onNavigate('deal_list')}>
              {deals.length === 0 ? <Empty>No open deals</Empty> : deals.slice(0, 8).map(d => (
                <Row key={d.id} onClick={() => onNavigate('deal', d.id)}>
                  <span className="text-sm text-paper truncate flex-1">{d.name}</span>
                  <span className="text-[10px] text-muted shrink-0">{(d.stage || '').replace(/_/g, ' ')}</span>
                  {d.value > 0 && <span className="text-[10px] text-emerald-600 font-mono shrink-0">{fmtMoney0(d.value, d.currency)}</span>}
                </Row>
              ))}
            </Section>

            {/* Leads */}
            <Section title="My leads" count={leads.length} onAll={() => onNavigate('lead_list')}>
              {leads.length === 0 ? <Empty>No active leads</Empty> : leads.slice(0, 8).map(l => (
                <Row key={l.id} onClick={() => onNavigate('lead', l.id)}>
                  <span className="text-sm text-paper truncate flex-1">{l.name}</span>
                  <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${LEAD_STAGE_MAP[l.stage]?.badge || ''}`}>
                    {LEAD_STAGE_MAP[l.stage]?.short || l.stage}
                  </span>
                </Row>
              ))}
            </Section>

          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, count, onAll, children }) {
  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-sm font-bold text-paper">{title}</h3>
        <span className="text-xs text-dim font-mono">({count})</span>
        {onAll && <button onClick={onAll} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">View all</button>}
      </div>
      <div className="p-2 space-y-1">{children}</div>
    </div>
  );
}

function Row({ onClick, children }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-2 px-2 py-2 rounded-xl hover:bg-card/60 text-left transition">
      {children}
    </button>
  );
}

function Empty({ children }) {
  return <div className="text-xs text-dim italic py-4 text-center">{children}</div>;
}
