import { useEffect, useState, useCallback, useMemo } from 'react';
import { supabase } from '../../lib/supabase';
import { useGoogleConnection } from '../../lib/useGoogle';
import { sanitizeEmailHtml } from '../../lib/emailHtml';
import { Mail, RefreshCw, Archive, Reply, Search, Link2, Plus, ExternalLink, Ticket, CheckSquare } from 'lucide-react';

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-personal`;

// Parse "Display Name <email@host>" -> { name, email }
function parseAddr(raw = '') {
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: raw.trim(), email: raw.trim().toLowerCase() };
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  const today = new Date();
  const sameDay = dt.toDateString() === today.toDateString();
  return sameDay
    ? dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Group a flat message list into conversations keyed by threadId. Each entry
// carries the latest message (for the preview row) + the count + unread state.
function groupConversations(messages) {
  const map = new Map();
  for (const m of messages) {
    const key = m.threadId || m.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  const convs = [...map.entries()].map(([threadId, items]) => {
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const latest = items[0];
    return {
      threadId,
      latest,
      count: items.length,
      unread: items.some((m) => m.unread),
      subject: latest.subject,
      fromName: parseAddr(latest.from).name,
      date: latest.date,
      snippet: latest.snippet,
    };
  });
  convs.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return convs;
}

export default function InboxPanel({ profile, onNavigate }) {
  const { connected, connect } = useGoogleConnection(profile.id);
  const [messages, setMessages] = useState([]);
  const [signature, setSignature] = useState('');
  const [signatureLogo, setSignatureLogo] = useState(false);
  const [brandingLogo, setBrandingLogo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [activeQ, setActiveQ] = useState('in:inbox');
  const [selected, setSelected] = useState(null); // selected conversation { threadId, ... }
  const [thread, setThread] = useState([]);        // full message list for the open thread
  const [threadLoading, setThreadLoading] = useState(false);

  const conversations = useMemo(() => groupConversations(messages), [messages]);

  const callFn = useCallback(async (payload) => {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Request failed');
    return d;
  }, []);

  const loadList = useCallback(async (q) => {
    setLoading(true); setError('');
    try {
      const d = await callFn({ action: 'list', q });
      setMessages(d.messages || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [callFn]);

  useEffect(() => { if (connected) loadList(activeQ); }, [connected, activeQ, loadList]);

  useEffect(() => {
    supabase.from('profiles').select('email_signature, email_signature_logo').eq('id', profile.id).maybeSingle()
      .then(r => { setSignature(r.data?.email_signature || ''); setSignatureLogo(!!r.data?.email_signature_logo); }).catch(() => {});
    supabase.from('support_settings').select('logo_url').eq('id', 1).maybeSingle()
      .then(r => setBrandingLogo(r.data?.logo_url || null));
  }, [profile.id]);

  const openConversation = async (conv) => {
    setSelected(conv); setThread([]); setThreadLoading(true); setError('');
    // Optimistically clear unread in the list.
    if (conv.unread) {
      setMessages(prev => prev.map(m => (m.threadId || m.id) === conv.threadId ? { ...m, unread: false } : m));
    }
    try {
      const d = await callFn({ action: 'thread', threadId: conv.threadId });
      const msgs = (d.messages && d.messages.length) ? d.messages : [conv.latest];
      setThread(msgs);
      // Mark any unread messages in the thread as read (best-effort).
      msgs.filter(m => m.unread).forEach(m => callFn({ action: 'modify', id: m.id, markRead: true }).catch(() => {}));
    } catch (e) { setError(e.message); setThread([conv.latest]); }
    setThreadLoading(false);
  };

  const archiveConversation = async (conv) => {
    try {
      // Archive every message in the thread we know about.
      const ids = thread.length ? thread.map(m => m.id) : [conv.latest.id];
      await Promise.all(ids.map(id => callFn({ action: 'modify', id, archive: true }).catch(() => {})));
      setMessages(prev => prev.filter(m => (m.threadId || m.id) !== conv.threadId));
      setSelected(null); setThread([]);
    } catch (e) { setError(e.message); }
  };

  const runSearch = (e) => {
    e?.preventDefault();
    setActiveQ(query.trim() ? `${query.trim()}` : 'in:inbox');
    setSelected(null); setThread([]);
  };

  if (connected === null) return <div className="h-full flex items-center justify-center text-dim text-sm">Loading inbox…</div>;

  if (connected === false) return (
    <div className="h-full flex flex-col items-center justify-center text-center p-8">
      <div className="w-14 h-14 rounded-2xl glass-inner flex items-center justify-center mb-4"><Mail size={26} className="text-ember" /></div>
      <div className="text-lg font-bold text-paper mb-1">Connect your inbox</div>
      <div className="text-sm text-muted max-w-sm mb-4">Link your Google account to read, reply to and triage your email here — and turn messages into CRM records.</div>
      <button onClick={connect} className="btn-glass px-5 py-2.5 rounded-xl text-sm font-semibold flex items-center gap-2">
        <Mail size={16} /> Connect Google
      </button>
      <div className="text-[11px] text-dim mt-2">Opens a Google sign-in window. Takes a few seconds.</div>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-bdr flex items-center gap-3 shrink-0">
        <Mail size={20} className="text-ember" />
        <div className="flex-1 min-w-0">
          <div className="text-lg font-bold text-paper leading-tight">Inbox</div>
          <div className="text-[11px] text-muted truncate">{connected.email}</div>
        </div>
        <form onSubmit={runSearch} className="hidden sm:flex items-center gap-1.5">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search mail…"
              className="pl-8 pr-3 py-1.5 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember w-48" />
          </div>
        </form>
        <button onClick={() => loadList(activeQ)} title="Refresh" className="btn-ghost p-2 rounded-xl"><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {error && <div className="mx-6 mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-2">{error}</div>}

      {/* Two-pane */}
      <div className="flex-1 min-h-0 flex">
        {/* Conversation list */}
        <div className={`${selected ? 'hidden md:flex' : 'flex'} flex-col w-full md:w-[380px] md:border-r border-bdr overflow-y-auto`}>
          {loading && !conversations.length ? (
            <div className="p-6 text-center text-dim text-sm">Loading…</div>
          ) : conversations.length === 0 ? (
            <div className="p-6 text-center text-dim text-sm">No messages.</div>
          ) : conversations.map(conv => {
            const active = selected?.threadId === conv.threadId;
            return (
              <button key={conv.threadId} onClick={() => openConversation(conv)}
                className={`text-left px-4 py-3 border-b border-bdr/60 transition ${active ? 'bg-ember/10' : 'hover:bg-card'} ${conv.unread ? '' : 'opacity-75'}`}>
                <div className="flex items-center gap-2">
                  {conv.unread && <span className="w-2 h-2 rounded-full bg-ember shrink-0" />}
                  <span className={`text-sm truncate flex-1 ${conv.unread ? 'font-bold text-paper' : 'font-medium text-muted'}`}>{conv.fromName}</span>
                  {conv.count > 1 && (
                    <span className="text-[10px] font-semibold text-muted bg-card border border-bdr rounded-full px-1.5 py-0.5 shrink-0">{conv.count}</span>
                  )}
                  <span className="text-[10px] text-dim shrink-0">{fmtDate(conv.date)}</span>
                </div>
                <div className={`text-sm truncate ${conv.unread ? 'text-paper' : 'text-muted'}`}>{conv.subject || '(no subject)'}</div>
                <div className="text-xs text-dim truncate mt-0.5">{conv.snippet}</div>
              </button>
            );
          })}
        </div>

        {/* Reading pane */}
        <div className={`${selected ? 'flex' : 'hidden md:flex'} flex-col flex-1 min-w-0 overflow-y-auto`}>
          {!selected ? (
            <div className="h-full flex items-center justify-center text-dim text-sm">Select a conversation to read</div>
          ) : (
            <ThreadView conv={selected} thread={thread} loading={threadLoading} connectedEmail={connected.email}
              profile={profile} onNavigate={onNavigate} onBack={() => { setSelected(null); setThread([]); }}
              onArchive={() => archiveConversation(selected)} callFn={callFn}
              signature={signature} signatureLogo={signatureLogo} brandingLogo={brandingLogo} />
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadView({ conv, thread, loading, connectedEmail, profile, onNavigate, onBack, onArchive, callFn, signature, signatureLogo, brandingLogo }) {
  const subject = conv.subject || thread[0]?.subject || '(no subject)';
  // Messages oldest -> newest for natural reading order.
  const ordered = useMemo(() => [...thread].sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0)), [thread]);
  const anchor = ordered[ordered.length - 1] || conv.latest; // newest message = reply target
  // The other party = newest message not sent by the connected user.
  const correspondent = useMemo(() => {
    const me = (connectedEmail || '').toLowerCase();
    for (let i = ordered.length - 1; i >= 0; i--) {
      const a = parseAddr(ordered[i].from);
      if (a.email && a.email !== me) return a;
    }
    return parseAddr(anchor?.from || conv.latest.from);
  }, [ordered, connectedEmail, anchor, conv]);

  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => {
    // Expand the newest message by default; collapse the rest.
    setExpanded(new Set(ordered.length ? [ordered[ordered.length - 1].id] : []));
  }, [conv.threadId, ordered.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState('');

  const [contact, setContact] = useState(undefined);
  const [linkMsg, setLinkMsg] = useState('');
  const [linking, setLinking] = useState(false);
  const [created, setCreated] = useState(null);

  const useLogo = signatureLogo && brandingLogo;

  useEffect(() => {
    setReplyOpen(false); setReplyBody(''); setSent(false); setErr(''); setLinkMsg(''); setCreated(null);
    setContact(undefined);
    if (correspondent.email) {
      supabase.from('contacts').select('id, first_name, last_name, email').ilike('email', correspondent.email).limit(1)
        .then(r => setContact(r.data?.[0] || null));
    } else setContact(null);
  }, [conv.threadId, correspondent.email]);

  const findCompanyId = async () => {
    if (!contact?.id) return null;
    const { data } = await supabase.from('associations').select('from_id, to_id, from_type, to_type')
      .or(`and(from_type.eq.contact,from_id.eq.${contact.id},to_type.eq.company),and(to_type.eq.contact,to_id.eq.${contact.id},from_type.eq.company)`).limit(1);
    return data && data.length ? (data[0].from_type === 'company' ? data[0].from_id : data[0].to_id) : null;
  };

  const bodyText = (m) => m.text || m.snippet || '';

  const createTicket = async () => {
    setLinking(true); setErr('');
    try {
      const companyId = await findCompanyId();
      const { data: t, error } = await supabase.from('tickets').insert({
        subject: subject || `Email from ${correspondent.name}`,
        description: bodyText(anchor),
        channel: 'email', source: 'inbox',
        customer_email: correspondent.email,
        contact_id: contact?.id || null,
        company_id: companyId,
        priority: 'P2', ticket_type: 'support', owner_id: profile.id,
      }).select('id, ticket_number').single();
      if (error) throw error;
      await supabase.from('stage_history').insert({ object_type: 'ticket', object_id: t.id, from_stage: null, to_stage: 'new', changed_by: profile.id });
      if (contact?.id) await supabase.from('associations').insert({ from_type: 'ticket', from_id: t.id, to_type: 'contact', to_id: contact.id, label: 'primary_contact' });
      setCreated({ type: 'ticket', id: t.id, label: t.ticket_number ? `Ticket #${t.ticket_number}` : 'Ticket' });
    } catch (e) { setErr('Could not create ticket: ' + e.message); }
    setLinking(false);
  };

  const createTask = async () => {
    setLinking(true); setErr('');
    try {
      const { data: t, error } = await supabase.from('tasks').insert({
        title: subject || `Follow up: ${correspondent.name}`,
        description: bodyText(anchor) + `\n\n(From email: ${correspondent.email})`,
        priority: 'P2', owner_id: profile.id,
      }).select('id').single();
      if (error) throw error;
      if (contact?.id) await supabase.from('associations').insert({ from_type: 'task', from_id: t.id, to_type: 'contact', to_id: contact.id, label: 'related' });
      setCreated({ type: 'task', id: t.id, label: 'Task' });
    } catch (e) { setErr('Could not create task: ' + e.message); }
    setLinking(false);
  };

  const send = async () => {
    if (!replyBody.trim()) return;
    setSending(true); setErr('');
    try {
      const sigText = signature ? `\n\n--\n${signature}` : '';
      const plain = replyBody + sigText;
      let html;
      if (useLogo || signature) {
        const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
        const sigHtml = (signature || useLogo)
          ? `<br><br><div style="color:#6b7280">--</div>` +
            (useLogo ? `<img src="${brandingLogo}" alt="" height="44" style="margin:6px 0;display:block">` : '') +
            (signature ? `<div>${nl2br(signature)}</div>` : '')
          : '';
        html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">${nl2br(replyBody)}${sigHtml}</div>`;
      }
      await callFn({
        action: 'send', to: correspondent.email,
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        body: plain, html,
        threadId: conv.threadId, inReplyTo: anchor.messageId, references: anchor.messageId,
      });
      setSent(true); setReplyOpen(false); setReplyBody('');
      if (contact?.id) {
        await supabase.from('crm_activities').insert({
          type: 'email', subject: `Re: ${subject}`, body: replyBody,
          subject_type: 'contact', subject_id: contact.id, contact_id: contact.id,
          actor_id: profile.id, direction: 'outbound', is_internal: false,
          occurred_at: new Date().toISOString(),
        });
      }
      setTimeout(() => setSent(false), 2500);
    } catch (e) { setErr(e.message); }
    setSending(false);
  };

  const logToCrm = async () => {
    if (!contact?.id) return;
    setLinking(true);
    await supabase.from('crm_activities').insert({
      type: 'email', subject: subject, body: bodyText(anchor),
      subject_type: 'contact', subject_id: contact.id, contact_id: contact.id,
      actor_id: profile.id, direction: 'inbound', is_internal: false,
      occurred_at: anchor?.date ? new Date(anchor.date).toISOString() : new Date().toISOString(),
      thread_id: conv.threadId,
      channel_metadata: { gmail_message_id: anchor?.id, from: anchor?.from },
    });
    setLinking(false);
    setLinkMsg('Logged to contact ✓');
    setTimeout(() => setLinkMsg(''), 2500);
  };

  const createContact = async () => {
    setLinking(true);
    const nameParts = correspondent.name.split(' ');
    const { data: c } = await supabase.from('contacts').insert({
      first_name: nameParts[0] || correspondent.email, last_name: nameParts.slice(1).join(' ') || null,
      email: correspondent.email, source: 'inbox', owner_id: profile.id,
    }).select('id, first_name, last_name, email').single();
    setContact(c || null);
    setLinking(false);
    setLinkMsg('Contact created ✓');
    setTimeout(() => setLinkMsg(''), 2500);
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  return (
    <div className="flex flex-col h-full">
      {/* Subject + actions */}
      <div className="px-6 py-4 border-b border-bdr shrink-0">
        <div className="flex items-start gap-3">
          <button onClick={onBack} className="md:hidden text-muted hover:text-paper text-lg mt-0.5">&larr;</button>
          <div className="flex-1 min-w-0">
            <div className="text-lg font-bold text-paper break-words">{subject}</div>
            <div className="text-sm text-muted mt-1">
              <span className="font-medium text-paper">{correspondent.name}</span>
              <span className="text-dim"> · {correspondent.email}</span>
              {ordered.length > 1 && <span className="text-dim"> · {ordered.length} messages</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button onClick={() => setReplyOpen(o => !o)} className="btn-glass px-3 py-1.5 rounded-xl text-sm font-semibold flex items-center gap-1.5"><Reply size={14} /> Reply</button>
          <button onClick={onArchive} className="btn-ghost px-3 py-1.5 rounded-xl text-sm flex items-center gap-1.5"><Archive size={14} /> Archive</button>

          <span className="w-px h-5 bg-bdr mx-0.5" />
          <button onClick={createTicket} disabled={linking} className="px-3 py-1.5 rounded-xl text-sm bg-blue-100 text-blue-700 border border-blue-200 hover:bg-blue-200 flex items-center gap-1.5"><Ticket size={14} /> Ticket</button>
          <button onClick={createTask} disabled={linking} className="px-3 py-1.5 rounded-xl text-sm bg-violet-100 text-violet-700 border border-violet-200 hover:bg-violet-200 flex items-center gap-1.5"><CheckSquare size={14} /> Task</button>

          <span className="w-px h-5 bg-bdr mx-0.5" />
          {contact === undefined ? null : contact ? (
            <>
              <button onClick={() => onNavigate?.('contact', contact.id)} className="px-3 py-1.5 rounded-xl text-sm bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-200 flex items-center gap-1.5">
                <ExternalLink size={14} /> {[contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email}
              </button>
              <button onClick={logToCrm} disabled={linking} className="btn-ghost px-3 py-1.5 rounded-xl text-sm flex items-center gap-1.5"><Link2 size={14} /> Log to CRM</button>
            </>
          ) : (
            <button onClick={createContact} disabled={linking} className="px-3 py-1.5 rounded-xl text-sm bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25 flex items-center gap-1.5"><Plus size={14} /> Create contact</button>
          )}
          {linkMsg && <span className="text-sm text-emerald-600 font-medium">{linkMsg}</span>}
          {sent && <span className="text-sm text-emerald-600 font-medium">Reply sent ✓</span>}
          {created && (
            <button onClick={() => onNavigate?.(created.type, created.id)} className="text-sm text-emerald-600 font-medium underline flex items-center gap-1">
              {created.label} created — open <ExternalLink size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Reply composer */}
      {replyOpen && (
        <div className="px-6 py-3 border-b border-bdr bg-card/50 shrink-0">
          <div className="text-[11px] text-dim mb-1">Replying to {correspondent.email}{(signature || useLogo) && ' · your signature will be added'}</div>
          <textarea className={input + ' resize-none'} rows={4} autoFocus value={replyBody}
            onChange={e => setReplyBody(e.target.value)} placeholder="Write your reply…" />
          {err && <div className="text-xs text-red-600 mt-1">{err}</div>}
          <div className="flex gap-2 mt-2">
            <button onClick={send} disabled={sending} className="btn-glass px-4 py-1.5 rounded-xl text-sm font-semibold disabled:opacity-50">{sending ? 'Sending…' : 'Send reply'}</button>
            <button onClick={() => setReplyOpen(false)} className="px-4 py-1.5 text-sm text-muted border border-bdr rounded-xl">Cancel</button>
          </div>
        </div>
      )}

      {/* Thread — each message separate, newest expanded */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-2 bg-card/30">
        {loading && !ordered.length ? (
          <div className="text-center text-dim text-sm py-8">Loading conversation…</div>
        ) : ordered.map((m, i) => {
          const a = parseAddr(m.from);
          const mine = a.email && a.email === (connectedEmail || '').toLowerCase();
          const isOpen = expanded.has(m.id);
          const isLast = i === ordered.length - 1;
          return (
            <div key={m.id} className={`rounded-2xl border border-bdr overflow-hidden ${mine ? 'bg-ember/5' : 'bg-card'}`}>
              <button onClick={() => toggle(m.id)} className="w-full text-left px-4 py-3 flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-glass-inner flex items-center justify-center text-[11px] font-bold text-paper shrink-0">
                  {(a.name || a.email || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-paper truncate">{mine ? 'You' : a.name}{m.unread && <span className="ml-2 inline-block w-2 h-2 rounded-full bg-ember align-middle" />}</div>
                  {!isOpen && <div className="text-xs text-dim truncate">{m.text || m.snippet || ''}</div>}
                </div>
                <div className="text-[10px] text-dim shrink-0">{m.date ? new Date(m.date).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</div>
              </button>
              {(isOpen || isLast) && (
                <div className="px-4 pb-4 pt-1 border-t border-bdr/50">
                  {m.text ? (
                    <div className="text-sm text-paper whitespace-pre-wrap break-words leading-relaxed">{m.text}</div>
                  ) : m.html ? (
                    <div className="rounded-lg border border-bdr overflow-auto" style={{ maxHeight: 600, background: '#fff', contain: 'layout paint', position: 'relative', isolation: 'isolate' }}>
                      <div className="prose-email text-sm break-words p-3" style={{ color: '#222' }} dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(m.html) }} />
                    </div>
                  ) : (
                    <div className="text-sm text-dim italic">No readable content.</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

