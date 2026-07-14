import { useEffect, useState, useRef, Fragment } from 'react';
import { supabase } from '../../lib/supabase';
import { cleanEmailBody, hasQuotedTail } from '../../lib/emailText';
import { emailHtmlFor, sanitizeEmailHtml } from '../../lib/emailHtml';

const TYPE_ICON = { call: '\u{1F4DE}', email: '\u{1F4E7}', sms: '\u{1F4AC}', note: '\u{1F4DD}', meeting: '\u{1F91D}', whatsapp: '\u{1F4F2}' };
const TYPE_LABEL = { call: 'Call', email: 'Email', sms: 'SMS', note: 'Note', meeting: 'Meeting', whatsapp: 'WhatsApp' };
const CHANNEL_TABS = [
  { key: 'note', label: 'Note', icon: '\u{1F4DD}' },
  { key: 'email', label: 'Email', icon: '\u{1F4E7}' },
  { key: 'sms', label: 'SMS', icon: '\u{1F4AC}' },
  { key: 'call', label: 'Call', icon: '\u{1F4DE}' },
];
const CALL_OUTCOMES = ['connected', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'callback_scheduled'];

export default function ConversationTimeline({ subjectType, subjectId, profile, contacts, ticket }) {
  const [activities, setActivities] = useState([]);
  const [members, setMembers] = useState([]);
  // Default channel: match the ticket's inbound channel, or 'note'
  const ticketChannel = ticket?.channel || null;
  const [channel, setChannel] = useState(ticketChannel || 'note');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [toEmail, setToEmail] = useState(ticket?.customer_email || '');
  const [toPhone, setToPhone] = useState(ticket?.customer_phone || '');
  const [direction, setDirection] = useState('outbound');
  const [callDuration, setCallDuration] = useState('');
  const [callOutcome, setCallOutcome] = useState('connected');
  const [isInternal, setIsInternal] = useState(true);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionPos, setMentionPos] = useState(0);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [isMsCrm, setIsMsCrm] = useState(false);
  const bodyRef = useRef(null);
  const scrollRef = useRef(null);
  // Which inbound emails have their quoted history expanded.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpand = (id) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const canWrite = profile.role === 'owner' || profile.role === 'editor';

  // Who to email for a follow-up: the ticket's captured email, else the linked
  // contact's email (fetched if not passed in) — so you can reach out
  // proactively even before the customer has replied (previously the reply box
  // had no address and blocked sending).
  const [customerEmail, setCustomerEmail] = useState(ticket?.customer_email || '');
  useEffect(() => {
    if (ticket?.customer_email) { setCustomerEmail(ticket.customer_email); return; }
    const fromProp = contacts?.find(c => c.id === ticket?.contact_id)?.email;
    if (fromProp) { setCustomerEmail(fromProp); return; }
    if (!ticket?.contact_id) return;
    let cancelled = false;
    supabase.from('contacts').select('email').eq('id', ticket.contact_id).maybeSingle()
      .then(({ data }) => { if (!cancelled && data?.email) setCustomerEmail(data.email); });
    return () => { cancelled = true; };
  }, [ticket?.customer_email, ticket?.contact_id, contacts]);

  // Prefill the reply-To as soon as an address is known. Never clobbers a typed value.
  useEffect(() => {
    if (!toEmail && customerEmail) setToEmail(customerEmail);
  }, [customerEmail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Support-mailbox provider: the microsoft_connections table exists only on the
  // Microsoft CRMs → reply via ms-send there, gmail-send otherwise.
  useEffect(() => {
    supabase.from('microsoft_connections').select('id').limit(1).then(r => setIsMsCrm(!r.error));
  }, []);

  useEffect(() => {
    load();
    // Live conversation: reload when any message lands on this record. Realtime
    // is primary; a slow poll is a fallback so replies still surface if the
    // realtime channel drops (e.g. laptop wake-from-sleep) or crm_activities
    // isn't in the DB's realtime publication.
    const ch = supabase.channel(`conv-${subjectType}-${subjectId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'crm_activities', filter: `subject_id=eq.${subjectId}` },
        load)
      .subscribe();
    const poll = setInterval(load, 25000);
    return () => { supabase.removeChannel(ch); clearInterval(poll); };
  }, [subjectType, subjectId]);

  useEffect(() => {
    // Scroll to bottom on new activities
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [activities]);

  const load = async () => {
    const [a, m, tpl] = await Promise.all([
      supabase.from('crm_activities')
        .select('*')
        .eq('subject_type', subjectType)
        .eq('subject_id', subjectId)
        .order('occurred_at', { ascending: true }),
      supabase.from('profiles').select('id, email, display_name'),
      supabase.from('templates').select('*').order('name'),
    ]);
    setActivities(a.data || []);
    setMembers(m.data || []);
    setTemplates(tpl.data || []);
  };

  // Insert a template into the composer, filling placeholders
  const applyTemplate = (t) => {
    const ctx = {
      contact_name: (contacts?.find(c => c.id === ticket?.contact_id)
        ? [contacts.find(c => c.id === ticket.contact_id).first_name, contacts.find(c => c.id === ticket.contact_id).last_name].filter(Boolean).join(' ')
        : '') || 'there',
      ticket_number: ticket?.ticket_number ? `#${ticket.ticket_number}` : '',
      company: '',
      agent_name: profile.display_name || profile.email?.split('@')[0] || '',
    };
    const fill = (s) => (s || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => ctx[k] ?? '');
    setBody(fill(t.body));
    if (t.subject && channel === 'email') setSubject(fill(t.subject));
    setShowTemplates(false);
  };

  const availableTemplates = templates.filter(t => t.channel === 'any' || t.channel === channel);

  // One-click AI draft: ask Claude for a channel-appropriate reply, fill the composer.
  const generateDraft = async () => {
    setAiLoading(true); setAiError('');
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
      const t = d.suggested_type;
      if (t && ['note', 'email', 'sms', 'call'].includes(t)) {
        setChannel(t);
        if (t === 'email' && customerEmail) setToEmail(customerEmail);
        if (t === 'sms' && ticket?.customer_phone) setToPhone(ticket.customer_phone);
        if (t === 'email' && d.suggested_subject && !subject.trim()) setSubject(d.suggested_subject);
      }
      bodyRef.current?.focus();
    } catch (e) {
      setAiError(e.message);
    }
    setAiLoading(false);
  };

  const getName = (id) => {
    const m = members.find(u => u.id === id);
    return m ? (m.display_name || m.email.split('@')[0]) : 'Unknown';
  };

  const getInitial = (id) => {
    const name = getName(id);
    return name[0]?.toUpperCase() || '?';
  };

  // @mention handling
  const handleBodyChange = (e) => {
    const val = e.target.value;
    setBody(val);

    // Check if we're in a @mention
    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atMatch = textBeforeCursor.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionFilter(atMatch[1].toLowerCase());
      setMentionPos(cursorPos);
    } else {
      setShowMentions(false);
    }
  };

  const insertMention = (member) => {
    const textBefore = body.slice(0, mentionPos).replace(/@\w*$/, '');
    const textAfter = body.slice(mentionPos);
    const mention = `@[${member.display_name || member.email.split('@')[0]}](${member.id})`;
    setBody(textBefore + mention + ' ' + textAfter);
    setShowMentions(false);
    bodyRef.current?.focus();
  };

  const filteredMembers = members.filter(m => {
    if (!mentionFilter) return true;
    const name = (m.display_name || m.email).toLowerCase();
    return name.includes(mentionFilter);
  });

  // Parse mentions for display
  const renderBody = (text) => {
    if (!text) return null;
    // Replace @[Name](id) with highlighted pills
    const parts = text.split(/(@\[[^\]]+\]\([^)]+\))/g);
    return parts.map((part, i) => {
      const match = part.match(/@\[([^\]]+)\]\(([^)]+)\)/);
      if (match) {
        return (
          <span key={i} className="inline-flex items-center px-1.5 py-0.5 rounded bg-ember/15 text-ember-deep text-xs font-medium mx-0.5">
            @{match[1]}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  const save = async () => {
    if (channel === 'note' && !body.trim()) return;
    if (channel === 'call' && !body.trim()) return;
    if (channel === 'email' && (!body.trim() || !toEmail.trim())) return;
    if (channel === 'sms' && (!body.trim() || !toPhone.trim())) return;
    setSending(true);

    // Email: send via the support mailbox — ms-send (Microsoft) or gmail-send (Gmail)
    if (channel === 'email' && subjectType === 'ticket') {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${isMsCrm ? 'ms-send' : 'gmail-send'}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session?.access_token}`,
            },
            body: JSON.stringify({
              ticket_id: subjectId,
              to: toEmail.trim(),
              subject: null, // always reply with the customer's email subject ("Re: …", threaded server-side)
              body: body.trim(),
            }),
          }
        );
        const result = await res.json();
        if (!res.ok) {
          alert('Email send failed: ' + (result.error || 'Unknown error'));
          setSending(false);
          return;
        }
        // Success - activity was created by the edge function
        setBody(''); setSubject(''); setToEmail('');
        setSending(false);
        load();
        return;
      } catch (err) {
        alert('Email send failed: ' + err.message);
        setSending(false);
        return;
      }
    }

    // SMS: send via Twilio edge function
    if (channel === 'sms' && subjectType === 'ticket') {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/twilio-send-sms`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session?.access_token}`,
            },
            body: JSON.stringify({
              ticket_id: subjectId,
              to: (toPhone || ticket?.customer_phone || '').trim(),
              body: body.trim(),
            }),
          }
        );
        const result = await res.json();
        if (!res.ok) {
          alert('SMS send failed: ' + (result.error || 'Unknown error'));
          setSending(false);
          return;
        }
        setBody(''); setToPhone('');
        setSending(false);
        load();
        return;
      } catch (err) {
        alert('SMS send failed: ' + err.message);
        setSending(false);
        return;
      }
    }

    // For notes, calls: create activity directly
    const record = {
      type: channel,
      subject: null,
      body: body.trim() || null,
      subject_type: subjectType,
      subject_id: subjectId,
      direction: channel === 'note' ? null : direction,
      actor_id: profile.id,
      is_internal: channel === 'note' ? isInternal : false,
      channel_metadata: {},
    };

    if (channel === 'sms') {
      record.channel_metadata = { to_number: toPhone, from_number: 'system' };
    } else if (channel === 'call') {
      const durationParts = callDuration.split(':').map(Number);
      const seconds = durationParts.length === 2 ? durationParts[0] * 60 + durationParts[1] : parseInt(callDuration) || 0;
      record.channel_metadata = { duration_seconds: seconds, outcome: callOutcome };
    }

    const { data: activity, error } = await supabase.from('crm_activities').insert(record).select().single();

    if (error) {
      alert('Failed to save: ' + error.message);
      setSending(false);
      return;
    }

    // Parse @mentions and create mention records
    if (body && activity) {
      const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g;
      let match;
      while ((match = mentionRegex.exec(body)) !== null) {
        const userId = match[2];
        await supabase.from('mentions').insert({
          activity_id: activity.id,
          mentioned_user_id: userId,
          ticket_id: subjectType === 'ticket' ? subjectId : null,
        });
      }
    }

    // Reset form
    setBody(''); setSubject(''); setToEmail(''); setToPhone('');
    setCallDuration(''); setCallOutcome('connected');
    setSending(false);
    load();
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  // Scroll-back aids: jump to oldest/latest + a floating "Latest" pill, and
  // sticky day dividers between messages from different days.
  const [showJump, setShowJump] = useState(false);
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  const onListScroll = (e) => { const el = e.target; setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 260); };
  const dayKeyOf = (ts) => new Date(ts).toDateString();
  const dayLabelOf = (ts) => {
    const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Conversation header — count + jump-to-oldest/latest */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-bdr shrink-0">
        <h3 className="text-sm font-bold text-paper">Conversation</h3>
        <span className="text-[10px] font-mono text-dim bg-card px-2 py-0.5 rounded-full">{activities.length} {activities.length === 1 ? 'message' : 'messages'}</span>
        <div className="flex-1" />
        {activities.length > 1 && (
          <>
            <button onClick={scrollToTop} title="Jump to oldest" className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-muted hover:text-paper hover:bg-card transition">↑ Oldest</button>
            <button onClick={scrollToBottom} title="Jump to latest" className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-muted hover:text-paper hover:bg-card transition">↓ Latest</button>
          </>
        )}
      </div>
      {/* Messages */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} onScroll={onListScroll} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {activities.length === 0 && (
          <div className="text-center text-dim text-xs py-8 italic">No conversation yet. Start by adding a note or sending a message.</div>
        )}
        {activities.map((a, idx) => {
          const isOutbound = a.direction === 'outbound' || !a.direction;
          const isNote = a.type === 'note';
          const isCall = a.type === 'call';
          const isAgent = !!a.actor_id;
          const showDivider = idx === 0 || dayKeyOf(a.occurred_at) !== dayKeyOf(activities[idx - 1].occurred_at);

          return (
            <Fragment key={a.id}>
              {showDivider && (
                <div className="sticky top-0 z-[3] flex justify-center py-1">
                  <span className="text-[10px] font-mono uppercase tracking-wider text-dim bg-card/90 backdrop-blur border border-bdr rounded-full px-3 py-1">{dayLabelOf(a.occurred_at)}</span>
                </div>
              )}
            <div className={`flex ${isNote ? 'justify-center' : isOutbound ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] ${
                isNote
                  ? 'w-full'
                  : isOutbound
                  ? ''
                  : ''
              }`}>
                {/* Note / Internal */}
                {isNote && (
                  <div className={`rounded-2xl p-3 ${a.is_internal ? 'bg-amber-50 border border-amber-200' : 'glass-card'}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 text-[9px] font-bold flex items-center justify-center">{getInitial(a.actor_id)}</span>
                      <span className="text-xs font-medium text-paper">{getName(a.actor_id)}</span>
                      {a.is_internal && <span className="text-[9px] text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded font-bold uppercase">Internal</span>}
                      <span className="text-[10px] text-dim ml-auto">{timeAgo(a.occurred_at)}</span>
                    </div>
                    <div className="text-sm text-paper leading-relaxed whitespace-pre-wrap">{renderBody(a.body)}</div>
                  </div>
                )}

                {/* Call / Voicemail */}
                {isCall && (() => {
                  const md = a.channel_metadata || {};
                  const isVoicemail = md.kind === 'voicemail' || md.outcome === 'voicemail';
                  const recSid = md.recording_sid;
                  const recUrl = recSid ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/twilio-recording?sid=${recSid}` : null;
                  const dur = md.recording_duration || md.duration_seconds;
                  return (
                    <div className={`rounded-2xl p-3 w-full ${isVoicemail ? 'bg-amber-50 border border-amber-200' : 'glass-card'}`}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="text-base">{isVoicemail ? '\u{1F4FC}' : TYPE_ICON.call}</span>
                        <span className="text-xs font-medium text-paper">{a.actor_id ? getName(a.actor_id) : (md.from_number || 'Customer')}</span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${isVoicemail ? 'bg-amber-100 text-amber-700' : a.direction === 'inbound' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                          {isVoicemail ? 'Voicemail' : `${a.direction === 'inbound' ? 'Inbound' : 'Outbound'} Call`}
                        </span>
                        <span className="text-[10px] text-dim ml-auto">{timeAgo(a.occurred_at)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted mt-1">
                        {dur > 0 && <span>{Math.floor(dur / 60)}m {dur % 60}s</span>}
                        {md.outcome && !isVoicemail && <span className="capitalize">{md.outcome.replace(/_/g, ' ')}</span>}
                      </div>
                      {recUrl && (
                        <audio controls preload="none" src={recUrl} className="w-full mt-2 h-8" />
                      )}
                      {md.transcription
                        ? <div className="text-sm text-paper mt-2 whitespace-pre-wrap italic">"{md.transcription}"</div>
                        : a.body && <div className="text-sm text-paper mt-2 whitespace-pre-wrap">{a.body}</div>}
                    </div>
                  );
                })()}

                {/* Email / SMS / WhatsApp */}
                {!isNote && !isCall && (
                  <div className={`rounded-2xl p-3 ${
                    isOutbound
                      ? 'bg-emerald-50 border border-emerald-200'
                      : 'bg-blue-50 border border-blue-200'
                  }`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm">{TYPE_ICON[a.type]}</span>
                      <span className="text-xs font-medium text-paper">
                        {isAgent ? getName(a.actor_id) : (a.channel_metadata?.from || a.channel_metadata?.from_number || 'Customer')}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        isOutbound ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                      }`}>{TYPE_LABEL[a.type]} {isOutbound ? 'sent' : 'received'}</span>
                      <span className="text-[10px] text-dim ml-auto">{timeAgo(a.occurred_at)}</span>
                    </div>
                    {a.subject && <div className="text-xs font-medium text-paper mb-1">{a.subject}</div>}
                    {a.channel_metadata?.to && <div className="text-[10px] text-muted mb-1">To: {a.channel_metadata.to}</div>}
                    {(() => {
                      const isInboundEmail = a.type === 'email' && !isOutbound;
                      // HTML emails (invoices, receipts, newsletters) render as
                      // sanitized HTML in a scrollable white frame so their own
                      // styling shows, instead of dumping raw tags as text.
                      const html = isInboundEmail ? emailHtmlFor(a) : null;
                      if (html) {
                        return (
                          <div className="mt-0.5 rounded-lg border border-bdr overflow-auto" style={{ maxHeight: 460, background: '#fff', contain: 'layout paint', position: 'relative', isolation: 'isolate' }}>
                            <div className="email-html p-3 text-sm" style={{ color: '#222' }}
                              dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(html) }} />
                          </div>
                        );
                      }
                      // Plain-text email: show only the new message + quoted toggle.
                      const showFull = expanded.has(a.id);
                      const text = isInboundEmail && !showFull ? cleanEmailBody(a.body) : a.body;
                      const trimmable = isInboundEmail && hasQuotedTail(a.body);
                      return (
                        <>
                          <div className="text-sm text-paper leading-relaxed whitespace-pre-wrap">{renderBody(text)}</div>
                          {trimmable && (
                            <button onClick={() => toggleExpand(a.id)}
                              className="mt-1 text-[10px] text-muted hover:text-paper underline underline-offset-2">
                              {showFull ? 'Hide quoted text' : 'Show quoted text'}
                            </button>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
            </Fragment>
          );
        })}
      </div>
      {showJump && (
        <button onClick={scrollToBottom} className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card text-ember-deep border border-bdr text-xs font-semibold shadow-md hover:bg-ember/10 transition">↓ Latest</button>
      )}
      </div>

      {/* Composer */}
      {canWrite && (
        <div className="border-t border-bdr px-4 py-3">
          {/* Channel indicator + tabs */}
          {ticketChannel && ticketChannel !== 'web' && (
            <div className="flex items-center gap-2 mb-2 px-1">
              <span className="text-[10px] text-muted">Customer contacted via</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase rounded-lg ${
                ticketChannel === 'sms' ? 'bg-blue-100 text-blue-700' : ticketChannel === 'email' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'
              }`}>{TYPE_ICON[ticketChannel]} {ticketChannel}</span>
              {ticket?.customer_phone && <span className="text-[10px] text-muted">{ticket.customer_phone}</span>}
              {ticket?.customer_email && <span className="text-[10px] text-muted">{ticket.customer_email}</span>}
            </div>
          )}
          <div className="flex gap-1 mb-3">
            {CHANNEL_TABS.map(t => (
              <button key={t.key} onClick={() => {
                setChannel(t.key);
                // Auto-fill customer contact from ticket
                if (t.key === 'email' && customerEmail) setToEmail(customerEmail);
                if (t.key === 'sms' && ticket?.customer_phone) setToPhone(ticket.customer_phone);
              }}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl transition ${
                  channel === t.key ? 'bg-ember text-white'
                  : t.key === ticketChannel ? 'bg-ember/10 text-ember border border-ember/20'
                  : 'bg-card text-muted hover:text-paper'
                }`}>
                <span>{t.icon}</span> {t.label}
                {t.key === ticketChannel && t.key !== 'note' && <span className="text-[8px] ml-0.5">*</span>}
              </button>
            ))}

            {/* Right-aligned tools: AI draft + Templates */}
            <div className="ml-auto flex items-center gap-1">
            {subjectType === 'ticket' && channel !== 'call' && (
              <button onClick={generateDraft} disabled={aiLoading}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-xl bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25 disabled:opacity-50">
                {aiLoading ? 'Generating…' : '✨ AI reply'}
              </button>
            )}
            {/* Templates picker */}
            {channel !== 'call' && availableTemplates.length > 0 && (
              <div className="relative">
                <button onClick={() => setShowTemplates(v => !v)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl bg-card text-muted hover:text-paper transition">
                  {'\u{1F4C4}'} Templates {'\u{25BE}'}
                </button>
                {showTemplates && (
                  <div className="absolute right-0 bottom-full mb-1 w-64 max-h-60 overflow-y-auto glass-card rounded-xl shadow-xl z-30">
                    {availableTemplates.map(t => (
                      <button key={t.id} onClick={() => applyTemplate(t)}
                        className="w-full px-3 py-2 text-left hover:bg-card/60 border-b border-bdr last:border-b-0">
                        <div className="text-sm text-paper">{t.name}</div>
                        <div className="text-[10px] text-dim truncate">{t.body}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            </div>
          </div>
          {aiError && <div className="text-[11px] text-red-600 mb-2 px-1">{aiError}</div>}

          {/* Email fields */}
          {channel === 'email' && (
            <div className="space-y-2 mb-2">
              <input className={input} value={toEmail || customerEmail} onChange={e => setToEmail(e.target.value)}
                placeholder="To email address" />
            </div>
          )}

          {/* SMS fields */}
          {channel === 'sms' && (
            <div className="mb-2">
              <input className={input} value={toPhone || ticket?.customer_phone || ''} onChange={e => setToPhone(e.target.value)}
                placeholder="To phone number" />
            </div>
          )}

          {/* Call fields */}
          {channel === 'call' && (
            <div className="grid grid-cols-3 gap-2 mb-2">
              <select className={input} value={direction} onChange={e => setDirection(e.target.value)}>
                <option value="outbound">Outbound call</option>
                <option value="inbound">Inbound call</option>
              </select>
              <input className={input} value={callDuration} onChange={e => setCallDuration(e.target.value)}
                placeholder="Duration (mm:ss)" />
              <select className={input} value={callOutcome} onChange={e => setCallOutcome(e.target.value)}>
                {CALL_OUTCOMES.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          )}

          {/* Note: internal toggle */}
          {channel === 'note' && (
            <div className="flex items-center gap-2 mb-2">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={isInternal} onChange={e => setIsInternal(e.target.checked)}
                  className="accent-ember" />
                <span className="text-xs text-muted">Internal note (not visible to customer)</span>
              </label>
            </div>
          )}

          {/* Body + send */}
          <div className="relative">
            <textarea
              ref={bodyRef}
              className={input + ' resize-none pr-20'}
              rows={channel === 'note' ? 3 : 4}
              value={body}
              onChange={handleBodyChange}
              placeholder={
                channel === 'note' ? 'Add a note... type @ to mention a team member'
                : channel === 'email' ? 'Email body...'
                : channel === 'sms' ? `SMS message... (${body.length}/160 chars)`
                : 'Call notes...'
              }
            />

            {/* @mention dropdown */}
            {showMentions && filteredMembers.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-64 glass-raised rounded-xl overflow-hidden shadow-lg z-10 max-h-40 overflow-y-auto">
                {filteredMembers.slice(0, 8).map(m => (
                  <button key={m.id} onClick={() => insertMention(m)}
                    className="w-full px-3 py-2 text-left text-sm text-paper hover:bg-ember/10 flex items-center gap-2 transition">
                    <span className="w-6 h-6 rounded-full bg-ember text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                      {(m.display_name || m.email)[0].toUpperCase()}
                    </span>
                    <span>{m.display_name || m.email.split('@')[0]}</span>
                  </button>
                ))}
              </div>
            )}

            {/* SMS character counter */}
            {channel === 'sms' && (
              <div className={`absolute bottom-2 right-16 text-[10px] font-mono ${body.length > 160 ? 'text-red-600' : 'text-dim'}`}>
                {body.length}/160
              </div>
            )}

            <button onClick={save} disabled={sending || (!body.trim() && channel !== 'call')}
              className="absolute bottom-2 right-2 btn-glass px-4 py-1.5 rounded-xl text-xs disabled:opacity-50">
              {sending ? '...' : channel === 'note' ? 'Add' : channel === 'call' ? 'Log' : 'Send'}
            </button>
          </div>
        </div>
      )}
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
