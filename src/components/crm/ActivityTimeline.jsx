import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { cleanEmailBody, hasQuotedTail } from '../../lib/emailText';
import { emailHtmlFor, sanitizeEmailHtml } from '../../lib/emailHtml';

const TYPE_ICON = { call: '\u{1F4DE}', email: '\u{1F4E7}', sms: '\u{1F4AC}', note: '\u{1F4DD}', meeting: '\u{1F91D}', whatsapp: '\u{1F4F2}' };
const TYPE_LABEL = { call: 'Call', email: 'Email', sms: 'SMS', note: 'Note', meeting: 'Meeting', whatsapp: 'WhatsApp' };

export const MEETING_OUTCOMES = [
  ['completed', 'Completed'], ['no_show', 'No show'], ['rescheduled', 'Rescheduled'], ['cancelled', 'Cancelled'],
];
const OUTCOME_STYLE = {
  completed: 'bg-emerald-100 text-emerald-700',
  no_show: 'bg-red-100 text-red-700',
  rescheduled: 'bg-amber-100 text-amber-700',
  cancelled: 'bg-slate-200 text-slate-500',
};

export default function ActivityTimeline({ subjectType, subjectId, profile, contactEmail }) {
  const [activities, setActivities] = useState([]);
  const [members, setMembers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [direction, setDirection] = useState('outbound');
  const [outcome, setOutcome] = useState('completed');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [to, setTo] = useState('');
  const [mailProvider, setMailProvider] = useState(null); // 'microsoft' | 'google' | null
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');

  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpand = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  const generateDraft = async () => {
    setAdding(true); setAiLoading(true); setAiError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ ticket_id: subjectId }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Could not generate a draft.');
      setBody(d.draft || '');
      if (d.suggested_type) setType(d.suggested_type);
      if (d.suggested_subject && !subject.trim()) setSubject(d.suggested_subject);
      setDirection('outbound');
    } catch (e) {
      setAiError(e.message);
    }
    setAiLoading(false);
  };

  useEffect(() => { load(); }, [subjectType, subjectId]);

  // Which personal mailbox (if any) the current user has connected — lets us
  // send the email AS them and log it, not just record a manual note.
  useEffect(() => {
    supabase.from('user_integrations').select('provider').eq('profile_id', profile.id).maybeSingle()
      .then(r => setMailProvider(r.data?.provider || null));
  }, [profile.id]);

  // Prefill the recipient with the record's contact when composing an email.
  useEffect(() => { if (type === 'email' && !to) setTo(contactEmail || ''); }, [type]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async () => {
    const [a, m] = await Promise.all([
      supabase.from('crm_activities')
        .select('*')
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId)
        .order('occurred_at', { ascending: false }),
      supabase.from('profiles').select('id, email, display_name'),
    ]);
    setActivities(a.data || []);
    setMembers(m.data || []);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!body.trim() && !subject.trim()) return;
    await supabase.from('crm_activities').insert({
      type,
      subject: subject.trim() || null,
      body: body.trim() || null,
      subject_type: subjectType,
      subject_id: subjectId,
      direction: type === 'note' ? null : direction,
      actor_id: profile.id,
      channel_metadata: type === 'meeting' ? { outcome } : (type === 'email' && to.trim() ? { to: to.trim() } : {}),
    });
    setType('note'); setSubject(''); setBody(''); setTo(''); setOutcome('completed'); setAdding(false);
    load();
  };

  // Send the email via the user's OWN mailbox (Outlook/Gmail) AND log it on the
  // record, so the whole thread lives against the lead/contact/deal.
  const sendEmail = async () => {
    const recipient = to.trim();
    if (!recipient) { setSendError('Add a recipient email.'); return; }
    if (!body.trim()) { setSendError('Write a message first.'); return; }
    setSending(true); setSendError('');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const fn = mailProvider === 'google' ? 'gmail-personal' : 'ms-personal';
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ action: 'send', to: recipient, subject: subject.trim() || '(no subject)', body }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Send failed (${res.status})`);
      await supabase.from('crm_activities').insert({
        type: 'email', direction: 'outbound',
        subject: subject.trim() || null, body: body.trim() || null,
        subject_type: subjectType, subject_id: subjectId, actor_id: profile.id,
        channel_metadata: { to: recipient, via: mailProvider, message_id: d.id || d.messageId || null },
      });
      setType('note'); setSubject(''); setBody(''); setTo(''); setAdding(false);
      load();
    } catch (err) { setSendError(err.message); }
    setSending(false);
  };

  // Record the outcome of a meeting after the fact (e.g. a scheduled calendar
  // meeting that has now happened — or didn't).
  const setMeetingOutcome = async (activity, value) => {
    await supabase.from('crm_activities')
      .update({ channel_metadata: { ...(activity.channel_metadata || {}), outcome: value } })
      .eq('id', activity.id);
    load();
  };

  const getName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : 'Unknown';
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";
  const label = "text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block";
  const emailReady = type === 'email' && direction === 'outbound' && !!mailProvider;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className={label + ' mb-0'}>Activity ({activities.length})</div>
        <div className="flex items-center gap-2">
          {canWrite && contactEmail && mailProvider && !adding && (
            <button onClick={() => { setType('email'); setDirection('outbound'); setTo(contactEmail); setAdding(true); }}
              className="px-2 py-1 text-xs font-semibold rounded-lg bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25">
              ✉ Email</button>
          )}
          {canWrite && subjectType === 'ticket' && (
            <button onClick={generateDraft} disabled={aiLoading}
              className="px-2 py-1 text-xs font-semibold rounded-lg bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25 disabled:opacity-50">
              {aiLoading ? 'Generating…' : '✨ AI reply'}</button>
          )}
          {canWrite && !adding && (
            <button onClick={() => setAdding(true)}
              className="px-2 py-1 text-xs text-ember hover:text-ember-deep">+ Log activity</button>
          )}
        </div>
      </div>

      {adding && (
        <form onSubmit={save} className="bg-card border border-bdr rounded-lg p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Type</label>
              <select className={input} value={type} onChange={e => setType(e.target.value)}>
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            {type === 'meeting' ? (
              <div>
                <label className={label}>Outcome</label>
                <select className={input} value={outcome} onChange={e => setOutcome(e.target.value)}>
                  {MEETING_OUTCOMES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </div>
            ) : type !== 'note' && (
              <div>
                <label className={label}>Direction</label>
                <select className={input} value={direction} onChange={e => setDirection(e.target.value)}>
                  <option value="outbound">Outbound</option>
                  <option value="inbound">Inbound</option>
                </select>
              </div>
            )}
          </div>
          {type === 'email' && (
            <div>
              <label className={label}>To</label>
              <input className={input} type="email" value={to} onChange={e => setTo(e.target.value)} placeholder="name@example.com" />
            </div>
          )}
          <div>
            <label className={label}>Subject</label>
            <input className={input} value={subject} onChange={e => setSubject(e.target.value)} placeholder="Brief summary" />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={label + ' mb-0'}>{emailReady ? 'Message' : 'Details'}</label>
              {subjectType === 'ticket' && (
                <button type="button" onClick={generateDraft} disabled={aiLoading}
                  className="text-[11px] font-semibold text-ember hover:text-ember-deep disabled:opacity-50">
                  {aiLoading ? 'Generating…' : '✨ Draft with AI'}</button>
              )}
            </div>
            <textarea className={input + ' resize-none'} rows={emailReady ? 6 : 4} value={body} onChange={e => setBody(e.target.value)} placeholder={emailReady ? 'Write your email…' : 'Notes, details...'} />
            {aiError && <div className="text-[11px] text-red-600 mt-1">{aiError}</div>}
            {body && subjectType === 'ticket' && <div className="text-[10px] text-dim mt-1">AI draft — review &amp; edit before saving.</div>}
          </div>
          {type === 'email' && direction === 'outbound' && !mailProvider && (
            <div className="text-[11px] text-dim">Connect your mailbox (Account → Connect Microsoft/Google) to send from here — for now this logs the email only.</div>
          )}
          {sendError && <div className="text-[11px] text-red-600">{sendError}</div>}
          <div className="flex gap-2">
            {emailReady ? (
              <>
                <button type="button" onClick={sendEmail} disabled={sending || !to.trim() || !body.trim()}
                  className="px-3 py-1.5 bg-ember text-ink text-xs font-semibold rounded hover:bg-ember-deep disabled:opacity-50">
                  {sending ? 'Sending…' : 'Send email'}</button>
                <button type="submit" className="px-3 py-1.5 text-xs text-muted border border-bdr rounded">Log only</button>
              </>
            ) : (
              <button type="submit" className="px-3 py-1.5 bg-ember text-ink text-xs font-semibold rounded hover:bg-ember-deep">Save</button>
            )}
            <button type="button" onClick={() => { setAdding(false); setSendError(''); }} className="px-3 py-1.5 text-xs text-muted border border-bdr rounded">Cancel</button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {activities.map(a => {
          const isMeeting = a.type === 'meeting';
          const mOutcome = a.channel_metadata?.outcome;
          const isFuture = new Date(a.occurred_at) > new Date();
          return (
          <div key={a.id} className="flex gap-3 py-2 border-b border-bdr last:border-b-0">
            <div className="text-base mt-0.5">{TYPE_ICON[a.type] || '\u{1F4DD}'}</div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs flex-wrap">
                <span className="text-paper font-medium">{getName(a.actor_id)}</span>
                <span className="text-dim">{TYPE_LABEL[a.type] || a.type}</span>
                {a.direction && !isMeeting && <span className="text-dim">{a.direction === 'inbound' ? '← in' : '→ out'}</span>}
                {isMeeting && mOutcome && (
                  <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase rounded ${OUTCOME_STYLE[mOutcome] || 'bg-slate-200 text-slate-600'}`}>
                    {(MEETING_OUTCOMES.find(([k]) => k === mOutcome)?.[1]) || mOutcome}
                  </span>
                )}
                {isMeeting && !mOutcome && (
                  isFuture
                    ? <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-blue-100 text-blue-700">Scheduled</span>
                    : canWrite && (
                      <select defaultValue="" onChange={e => e.target.value && setMeetingOutcome(a, e.target.value)}
                        className="px-1.5 py-0.5 text-[10px] bg-amber-50 border border-amber-300 text-amber-800 rounded-lg focus:outline-none">
                        <option value="">Log outcome…</option>
                        {MEETING_OUTCOMES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    )
                )}
                <span className="text-dim ml-auto">{timeAgo(a.occurred_at)}</span>
              </div>
              {a.type === 'email' && a.channel_metadata?.to && <div className="text-[10px] text-dim mt-0.5">To: {a.channel_metadata.to}</div>}
              {a.subject && <div className="text-sm text-paper mt-0.5">{a.subject}</div>}
              {a.body && (() => {
                const isInboundEmail = a.type === 'email' && a.direction === 'inbound';
                const html = isInboundEmail ? emailHtmlFor(a) : null;
                if (html) {
                  return (
                    <div className="mt-1 rounded-lg border border-bdr overflow-auto" style={{ maxHeight: 420, background: '#fff', contain: 'layout paint', position: 'relative', isolation: 'isolate' }}>
                      <div className="email-html p-3 text-xs" style={{ color: '#222' }}
                        dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(html) }} />
                    </div>
                  );
                }
                const showFull = expanded.has(a.id);
                const text = isInboundEmail && !showFull ? cleanEmailBody(a.body) : a.body;
                const trimmable = isInboundEmail && hasQuotedTail(a.body);
                return (
                  <>
                    <div className="text-xs text-muted mt-1 whitespace-pre-wrap">{text}</div>
                    {trimmable && (
                      <button onClick={() => toggleExpand(a.id)}
                        className="mt-1 text-[10px] text-dim hover:text-paper underline underline-offset-2">
                        {showFull ? 'Hide quoted text' : 'Show quoted text'}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
          );
        })}
        {activities.length === 0 && (
          <div className="text-xs text-dim italic py-4 text-center">No activity yet.</div>
        )}
      </div>
    </div>
  );
}

function timeAgo(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 2592000) return Math.floor(d / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}
