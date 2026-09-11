import { useEffect, useLayoutEffect, useMemo, useState, useRef, Fragment } from 'react';
import { supabase } from '../../lib/supabase';
import { cleanEmailBody, hasQuotedTail } from '../../lib/emailText';
import { emailHtmlFor, sanitizeEmailHtml } from '../../lib/emailHtml';
import { hasOtherRecipients, headerList } from '../../lib/replyRecipients';
import {
  sameActivities, sameValue, arrivedAtBottom, newestAt, followNewRows, addedMentions, latestEmail, needsRecipientLookup,
  emailHeadersOf, replyDefaults, recipientsToSend, formatAddresses, isSendShortcut, sendShortcutLabel,
} from '../../lib/conversation';
import AddressInput from './AddressInput.jsx';

// The support mailbox is always ours, whatever else gmail_connections lists.
const SUPPORT_MAILBOX = 'support@serv-os.app';
// How close to the bottom still counts as "reading the latest". Checked as the
// reader scrolls, so it is known before new rows make the list taller.
const NEAR_BOTTOM_PX = 120;

const TYPE_ICON = { call: '\u{1F4DE}', email: '\u{1F4E7}', sms: '\u{1F4AC}', note: '\u{1F4DD}', meeting: '\u{1F91D}', whatsapp: '\u{1F4F2}', chat: '\u{1F4AD}' };
const TYPE_LABEL = { call: 'Call', email: 'Email', sms: 'SMS', note: 'Note', meeting: 'Meeting', whatsapp: 'WhatsApp', chat: 'Chat' };
const CHANNEL_TABS = [
  { key: 'note', label: 'Note', icon: '\u{1F4DD}' },
  { key: 'email', label: 'Email', icon: '\u{1F4E7}' },
  { key: 'sms', label: 'SMS', icon: '\u{1F4AC}' },
  { key: 'call', label: 'Call', icon: '\u{1F4DE}' },
];
const CALL_OUTCOMES = ['connected', 'voicemail', 'no_answer', 'busy', 'wrong_number', 'callback_scheduled'];
const TICKET_STAGES = ['new','in_progress','waiting_on_customer','escalated','resolved','closed'];
const TICKET_STAGE_LABELS = { new:'New', in_progress:'In Progress', waiting_on_customer:'Waiting on Customer', escalated:'Escalated', resolved:'Resolved', closed:'Closed' };

// `active` is false while a phone is showing the Details tab: the list is
// display:none then, which loses its scroll position, so it is put back at the
// latest message when the tab comes back. Desktop callers leave it alone.
export default function ConversationTimeline({ subjectType, subjectId, profile, contacts, ticket, onTicketUpdated, active = true }) {
  const [activities, setActivities] = useState([]);
  const [members, setMembers] = useState([]);
  // Default channel: match the ticket's inbound channel, or 'note'
  const ticketChannel = ticket?.channel || null;
  // Chat tickets start on 'note' until the live-session query confirms the
  // visitor's widget is still open — then the effect below promotes the tab.
  const [channel, setChannel] = useState(ticketChannel === 'chat' ? 'note' : (ticketChannel || 'note'));
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  // Email reply recipients as chips. Text typed but not yet a chip is kept
  // apart so a send can include it, or refuse it when it is not an address.
  const [toList, setToList] = useState([]);
  const [ccList, setCcList] = useState([]);
  const [toPending, setToPending] = useState('');
  const [ccPending, setCcPending] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [replyMode, setReplyMode] = useState('reply'); // 'reply' | 'all'
  const [recipientsVersion, setRecipientsVersion] = useState(0); // remounts the chip boxes to clear typed text
  const recipientsTouched = useRef(false); // once edited by hand, refreshes stop rewriting them
  const [sendError, setSendError] = useState('');
  const [ownEmails, setOwnEmails] = useState([SUPPORT_MAILBOX]);
  const [fetchedHeaders, setFetchedHeaders] = useState({}); // activity id -> headers read back from Gmail
  const askedRecipients = useRef(new Set());
  // Inline edit of one of your own internal notes. The draft lives here, not
  // on the row, so a refresh landing mid-edit cannot overwrite it.
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  const [toPhone, setToPhone] = useState(ticket?.customer_phone || '');
  const [direction, setDirection] = useState('outbound');
  const [callDuration, setCallDuration] = useState('');
  const [callOutcome, setCallOutcome] = useState('connected');
  const [isInternal, setIsInternal] = useState(true);
  const [sending, setSending] = useState(false);
  const [askStatus, setAskStatus] = useState(false);
  const [editTo, setEditTo] = useState(false);   // phones: reveal the To field
  const [templates, setTemplates] = useState([]);
  // The live website-chat session behind this ticket (status 'escalated').
  // Non-null = the visitor's widget is still open and polling: the Chat tab
  // appears and replies land in their panel within seconds.
  const [chatSession, setChatSession] = useState(undefined);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionPos, setMentionPos] = useState(0);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [isMsCrm, setIsMsCrm] = useState(false);
  const [mySignature, setMySignature] = useState('');
  const [sigPool, setSigPool] = useState({ names: [], template: '' });
  // Images/files staged in the composer to send with an email reply.
  const [pendingFiles, setPendingFiles] = useState([]); // [{ file, name, size }]
  const attachRef = useRef(null);
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

  // Our own addresses: never offered as a recipient, and a message FROM one of
  // them is answered as our own (it goes back to the people it was sent to).
  useEffect(() => {
    supabase.from('gmail_connections_safe').select('email').then(({ data, error }) => {
      if (error || !data) return;
      const next = [...new Set([...data.map(r => String(r.email || '').trim().toLowerCase()).filter(Boolean), SUPPORT_MAILBOX])];
      setOwnEmails(prev => (sameValue(prev, next) ? prev : next));
    });
  }, []);

  // Reply target = the latest email in the thread, either direction.
  const emailAnchor = useMemo(() => latestEmail(activities), [activities]);
  const anchorHeaders = useMemo(
    () => emailHeadersOf(emailAnchor, emailAnchor ? fetchedHeaders[emailAnchor.id] : null, SUPPORT_MAILBOX),
    [emailAnchor, fetchedHeaders]
  );
  const canReplyAll = !!anchorHeaders && hasOtherRecipients(anchorHeaders, ownEmails);
  const defaults = useMemo(() => replyDefaults(anchorHeaders, ownEmails, customerEmail, replyMode), [anchorHeaders, ownEmails, customerEmail, replyMode]);
  const defaultsKey = JSON.stringify(defaults); // names too, so "Dan Marsh" replaces a bare fallback address

  // Keep To/Cc on the defaults as the thread moves (the customer address loads,
  // Cc is read back from Gmail) until someone edits them by hand. `filledFrom`
  // is the email they were filled from. Once a reply is being written, a newer
  // email landing never quietly changes who it goes to: the chips stay put and
  // a line above them offers to switch.
  const [filledFrom, setFilledFrom] = useState(null);
  const forceDefaults = useRef(false);
  const anchorId = emailAnchor?.id || null;
  useEffect(() => {
    const force = forceDefaults.current;
    forceDefaults.current = false;
    if (!force) {
      if (recipientsTouched.current) return;
      if (body.trim() && toList.length && filledFrom && filledFrom !== anchorId) return;
    }
    setFilledFrom(anchorId);
    setToList(defaults.to);
    setCcList(defaults.cc);
    if (force) setShowCc(defaults.cc.length > 0);
    else if (defaults.cc.length) setShowCc(true);
  }, [defaultsKey, recipientsVersion, anchorId]); // eslint-disable-line react-hooks/exhaustive-deps
  const sameEmails = (a, b) => a.length === b.length && a.every((x, i) => x.email === b[i].email);
  const newerEmailWaiting = channel === 'email' && !!filledFrom && !!anchorId && filledFrom !== anchorId
    && !(sameEmails(defaults.to, toList) && sameEmails(defaults.cc, ccList));

  // Back to the defaults for a mode: after a send, or on picking Reply / Reply
  // all. The effect above fills them on the next render, from the thread as it
  // is then (not as it was when Send was pressed).
  const resetRecipients = (mode = replyMode) => {
    if (mode !== replyMode) setReplyMode(mode);
    recipientsTouched.current = false;
    forceDefaults.current = true;
    setToPending(''); setCcPending(''); setSendError('');
    setRecipientsVersion(v => v + 1);
  };
  const chooseReplyMode = (mode) => resetRecipients(mode);
  const touchRecipients = () => { recipientsTouched.current = true; setSendError(''); };

  // Support-mailbox provider: the microsoft_connections table exists only on the
  // Microsoft CRMs → reply via ms-send there, gmail-send otherwise.
  useEffect(() => {
    supabase.from('microsoft_connections').select('id').limit(1).then(r => setIsMsCrm(!r.error));
  }, []);

  // An email captured before To and Cc were stored only knows its sender, so
  // Reply all would have nobody to copy. Ask gmail-send to read its headers
  // back from Gmail: once per email, and only while an email reply is being
  // written (never from the refresh loop).
  useEffect(() => {
    if (!canWrite || isMsCrm || subjectType !== 'ticket' || channel !== 'email') return;
    const a = emailAnchor;
    if (!needsRecipientLookup(a) || askedRecipients.current.has(a.id)) return;
    askedRecipients.current.add(a.id);
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({ action: 'recipients', activity_id: a.id }),
        });
        if (!res.ok) return; // stays a reply to the sender, as before
        const d = await res.json();
        setFetchedHeaders(prev => ({ ...prev, [a.id]: d }));
      } catch { /* offline: the sender is still known */ }
    })();
  }, [channel, emailAnchor?.id, isMsCrm]); // eslint-disable-line react-hooks/exhaustive-deps

  // The sender's saved signature (Account page) — appended to ticket email replies
  // exactly like the personal Inbox does.
  useEffect(() => {
    supabase.from('profiles').select('email_signature').eq('id', profile.id).maybeSingle()
      .then(r => setMySignature(r.data?.email_signature || '')).catch(() => {});
    // Optional shared pool: replies get signed by a random name from it.
    supabase.from('support_settings').select('signature_names, signature_template').eq('id', 1).maybeSingle()
      .then(r => setSigPool({ names: r.data?.signature_names || [], template: r.data?.signature_template || '' }))
      .catch(() => {});
  }, [profile.id]);

  // The signature for THIS send: a random name from the shared pool when one is
  // configured, otherwise the agent's own. Picked per send, so a thread can be
  // answered by different names.
  const signatureForSend = () => {
    const names = (sigPool.names || []).filter(Boolean);
    if (!names.length) return mySignature;
    const name = names[Math.floor(Math.random() * names.length)];
    const tpl = (sigPool.template || '').trim();
    return tpl ? tpl.replace(/\{\{\s*name\s*\}\}/g, name) : name;
  };

  // Auto-grow the composer with its content so a long reply is fully visible
  // while writing it. Capped at ~13 lines on desktop; much tighter on a phone,
  // where a tall box would leave no room for the conversation above it.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const cap = typeof window !== 'undefined' && window.innerWidth < 1024 ? 150 : 340;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight + 2, cap) + 'px';
  }, [body, channel]);

  useEffect(() => {
    if (chatSession === undefined) return; // not looked up yet
    if (chatSession && ticketChannel === 'chat' && channel === 'note' && !body.trim()) setChannel('chat');
    if (!chatSession && channel === 'chat') setChannel('note');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSession]);

  useEffect(() => {
    load();
    // Live conversation: reload when any message lands on this record. Realtime
    // is primary; a slow poll is a fallback so replies still surface if the
    // realtime channel drops (e.g. laptop wake-from-sleep) or crm_activities
    // isn't in the DB's realtime publication.
    // UPDATE too: a note edited by its author (or recipients saved onto an
    // older email) shows for everyone watching the ticket.
    const ch = supabase.channel(`conv-${subjectType}-${subjectId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'crm_activities', filter: `subject_id=eq.${subjectId}` },
        load)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'crm_activities', filter: `subject_id=eq.${subjectId}` },
        load)
      .subscribe();
    const poll = setInterval(load, 25000);
    return () => { supabase.removeChannel(ch); clearInterval(poll); };
  }, [subjectType, subjectId]);

  // Scrolling. The list used to jump to the bottom on every refresh, so anyone
  // reading further up was snapped to the latest reply within 25 seconds. Now
  // it opens at the latest message and only follows new rows when the reader
  // was already at the bottom, or the new row is their own. Otherwise the view
  // stays put and the Latest pill counts what arrived.
  const nearBottomRef = useRef(true);   // where the reader left the list, updated on scroll
  const seenIdsRef = useRef(null);      // ids on screen at the last render, null before the first
  const seenNewestRef = useRef(null);   // newest occurred_at on screen at the last render
  const pinUntilRef = useRef(0);        // briefly keep the bottom pinned while images load in
  const contentRef = useRef(null);
  const [unseen, setUnseen] = useState(0);

  // Jump to the latest message. Does nothing while the list is hidden (the
  // phone's Details tab): clientHeight is 0 then and the write is thrown away.
  const jumpToLatest = (smooth = false) => {
    const el = scrollRef.current;
    if (!el || el.clientHeight === 0) return false;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    nearBottomRef.current = true;
    pinUntilRef.current = Date.now() + 1500;
    setUnseen(0);
    return true;
  };

  // Before paint, so following a new row never flashes the old position.
  useLayoutEffect(() => {
    const prevIds = seenIdsRef.current;
    const prevNewest = seenNewestRef.current;
    seenIdsRef.current = new Set(activities.map(r => r.id));
    seenNewestRef.current = newestAt(activities);
    if (!activities.length) return;
    if (!prevIds || prevIds.size === 0) { jumpToLatest(); return; } // first paint
    const fresh = arrivedAtBottom(prevIds, activities, prevNewest); // [] for a refresh with no new rows, or an edit
    const action = followNewRows({ fresh, nearBottom: nearBottomRef.current, myId: profile.id, editing: !!editingId });
    if (action === 'follow') jumpToLatest();
    else if (action === 'count' && scrollRef.current?.clientHeight > 0) setUnseen(n => n + fresh.length);
  }, [activities]); // eslint-disable-line react-hooks/exhaustive-deps

  // Phones: coming back to the conversation tab puts you at the latest message.
  useEffect(() => { if (active) jumpToLatest(); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stay at the bottom when the list itself changes size under a reader who is
  // there: the composer growing, the phone keyboard, or (for a moment after a
  // jump) images and email frames loading in. A reader scrolled up is never moved.
  useEffect(() => {
    const el = scrollRef.current, inner = contentRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      if (!nearBottomRef.current || el.clientHeight === 0) return;
      const listResized = entries.some(e => e.target === el);
      if (listResized || Date.now() < pinUntilRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el); ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // A newer load (or a saved edit) supersedes any still in flight, so an old
  // response can never put stale rows back.
  const loadSeq = useRef(0);
  const load = async () => {
    const seq = ++loadSeq.current;
    let a, m, tpl, cs;
    try {
      [a, m, tpl, cs] = await Promise.all([
        supabase.from('crm_activities')
          .select('*')
          .eq('subject_type', subjectType)
          .eq('subject_id', subjectId)
          .order('occurred_at', { ascending: true }),
        supabase.from('profiles').select('id, email, display_name'),
        supabase.from('templates').select('*').order('name'),
        subjectType === 'ticket'
          ? supabase.from('chat_sessions').select('id, status').eq('ticket_id', subjectId).eq('status', 'escalated').maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
    } catch { return; } // offline: keep what is on screen
    if (seq !== loadSeq.current) return;
    // Keep the same arrays when nothing changed, so a quiet refresh re-renders
    // nothing, and never blank the thread because one request failed.
    if (!a.error && Array.isArray(a.data)) setActivities(prev => (sameActivities(prev, a.data) ? prev : a.data));
    if (!m.error && Array.isArray(m.data)) setMembers(prev => (sameValue(prev, m.data) ? prev : m.data));
    if (!tpl.error && Array.isArray(tpl.data)) setTemplates(prev => (sameValue(prev, tpl.data) ? prev : tpl.data));
    if (cs.error) return;
    setChatSession(prev => {
      const next = cs.data || null;
      if (prev && next && prev.id === next.id && prev.status === next.status) return prev;
      return next;
    });
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
        // Email recipients already follow the thread (see the defaults effect).
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

  // Stage image/PDF attachments for an email reply. 3 MB cap per file keeps us
  // within Microsoft Graph's direct-attachment limit (so it works on all CRMs).
  const onPickAttach = (e) => {
    const picked = Array.from(e.target.files || []);
    if (attachRef.current) attachRef.current.value = '';
    const ok = [];
    for (const file of picked) {
      if (file.size > 3 * 1024 * 1024) { alert(`${file.name} is over 3 MB — please attach a smaller image.`); continue; }
      ok.push({ file, name: file.name, size: file.size });
    }
    if (ok.length) setPendingFiles(prev => [...prev, ...ok]);
  };
  const removePending = (i) => setPendingFiles(prev => prev.filter((_, idx) => idx !== i));

  // Upload staged files to the private bucket and return path refs for the send fn.
  const uploadPending = async () => {
    const refs = [];
    for (const p of pendingFiles) {
      const safe = p.name.replace(/[^\w.\-]+/g, '_');
      const path = `ticket/${subjectId}/${crypto.randomUUID()}-${safe}`;
      const { error } = await supabase.storage.from('attachments').upload(path, p.file, {
        contentType: p.file.type || 'application/octet-stream', upsert: false,
      });
      if (error) { alert('Attachment upload failed: ' + error.message); return null; }
      refs.push({ path, name: p.name, type: p.file.type || 'application/octet-stream', size: p.size });
    }
    return refs;
  };

  // The status chosen in the send popover, applied once the reply is out.
  const applyStage = async (nextStage) => {
    if (!nextStage || subjectType !== 'ticket' || !ticket || nextStage === ticket.stage) return;
    const patch = { stage: nextStage };
    if (nextStage === 'resolved') patch.resolved_at = new Date().toISOString();
    if (nextStage === 'closed') patch.closed_at = new Date().toISOString();
    await supabase.from('tickets').update(patch).eq('id', subjectId);
    await supabase.from('stage_history').insert({ object_type: 'ticket', object_id: subjectId, from_stage: ticket.stage, to_stage: nextStage, changed_by: profile.id });
    onTicketUpdated?.();
  };

  const save = async (nextStage) => {
    if (channel === 'note' && !body.trim()) return;
    if (channel === 'call' && !body.trim()) return;
    if (channel === 'chat' && (!body.trim() || !chatSession)) return;
    const recipients = channel === 'email' ? recipientsToSend({ to: toList, toPending, cc: ccList, ccPending }) : null;
    if (channel === 'email' && !body.trim()) return;
    if (recipients?.problem) { setSendError(recipients.problem); setEditTo(true); return; }
    if (channel === 'sms' && (!body.trim() || !(toPhone || ticket?.customer_phone || '').trim())) return;
    setSending(true);

    // Email: send via the support mailbox — ms-send (Microsoft) or gmail-send (Gmail)
    if (channel === 'email' && subjectType === 'ticket') {
      try {
        const attachRefs = pendingFiles.length ? await uploadPending() : [];
        if (attachRefs === null) { setSending(false); return; } // upload failed
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
              to: headerList(recipients.to),
              cc: headerList(recipients.cc) || null,
              subject: null, // always reply with the customer's email subject ("Re: …", threaded server-side)
              body: (() => { const sig = signatureForSend(); return body.trim() + (sig ? `\n\n--\n${sig}` : ''); })(),
              attachments: attachRefs,
            }),
          }
        );
        const result = await res.json().catch(() => ({}));
        if (!res.ok) {
          // gmail-send explains a refusal (bad address, too many recipients) in `error`.
          setSendError(result.error || `Email send failed (${res.status}).`);
          alert('Email send failed: ' + (result.error || 'Unknown error'));
          setSending(false);
          return;
        }
        // Success - activity was created by the edge function
        await applyStage(nextStage);
        setBody(''); setSubject(''); setPendingFiles([]);
        // Back to the defaults, not empty: an empty To made the next send do
        // nothing until the Email tab was clicked again. The reload then moves
        // them onto the email just sent.
        resetRecipients();
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
        await applyStage(nextStage);
        setBody(''); setToPhone(ticket?.customer_phone || ''); // a blank box made the next text do nothing
        setSending(false);
        load();
        return;
      } catch (err) {
        alert('SMS send failed: ' + err.message);
        setSending(false);
        return;
      }
    }

    // Live chat: one insert feeds the visitor's widget (chat_messages, which
    // its poll reads) and one mirrors the reply onto the ticket thread.
    if (channel === 'chat' && subjectType === 'ticket' && chatSession) {
      const text = body.trim();
      // Status-guarded touch first: if another agent resolved the ticket (or
      // ended the chat) seconds ago, this returns no row and the message is
      // NOT sent into a conversation the customer has already seen close.
      const { data: liveRow } = await supabase.from('chat_sessions')
        .update({ last_at: new Date().toISOString() })
        .eq('id', chatSession.id).eq('status', 'escalated').select('id');
      if (!liveRow?.length) {
        alert('This chat has ended — the message was not sent. Use SMS or email instead.');
        setChatSession(null); setChannel('note'); setSending(false); load();
        return;
      }
      const { error: cmErr } = await supabase.from('chat_messages')
        .insert({ session_id: chatSession.id, role: 'agent', content: text });
      if (cmErr) { alert('Chat send failed: ' + cmErr.message); setSending(false); return; }
      await supabase.from('crm_activities').insert({
        type: 'chat', body: text, subject_type: 'ticket', subject_id: subjectId,
        direction: 'outbound', actor_id: profile.id, is_internal: false,
        channel_metadata: { source: 'website_chat', session_id: chatSession.id, author: profile.display_name || 'Agent' },
      });
      await applyStage(nextStage);
      setBody('');
      setSending(false);
      load();
      return;
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
    } else if (channel === 'email' && recipients) {
      record.channel_metadata = { to: headerList(recipients.to), cc: headerList(recipients.cc) || null };
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
    setBody(''); setSubject(''); setToPhone(ticket?.customer_phone || '');
    if (channel === 'email') resetRecipients();
    setCallDuration(''); setCallOutcome('connected');
    setSending(false);
    load();
  };

  // The Send / Add / Log button and Cmd/Ctrl+Enter share one path, so the
  // shortcut can never skip a check the button makes. Ticket email and SMS
  // still ask for the ticket status first.
  const submitComposer = ({ toggle = false } = {}) => {
    if (sending || (!body.trim() && channel !== 'call')) return;
    if (subjectType === 'ticket' && (channel === 'email' || channel === 'sms')) {
      if (channel === 'email' && !askStatus) {
        const { problem } = recipientsToSend({ to: toList, toPending, cc: ccList, ccPending });
        setSendError(problem || ''); // an old warning never outlives the text it was about
        if (problem) { setEditTo(true); return; }
      }
      setAskStatus(v => (toggle ? !v : true));
    } else save();
  };
  const onComposerKeyDown = (e) => {
    // Plain Enter and Shift+Enter stay new lines.
    if (!isSendShortcut(e)) return;
    e.preventDefault();
    submitComposer();
  };
  const shortcut = sendShortcutLabel();

  // Editing your own internal notes. Customer emails, SMS, chat, calls and
  // meetings are records of what was said and stay as they are.
  const canEditNote = (a) => canWrite && a.type === 'note' && !!a.is_internal && a.actor_id === profile.id && !a.channel_metadata?.system;
  const startEdit = (a) => { setEditingId(a.id); setEditDraft(a.body || ''); setEditError(''); };
  const cancelEdit = () => { setEditingId(null); setEditDraft(''); setEditError(''); };
  const saveEdit = async (a) => {
    if (editSaving) return;
    const text = editDraft.trim();
    const before = a.body || ''; // read now: the row object may be refreshed while the save is in flight
    if (!text) { setEditError('A note cannot be empty. Press Cancel to keep it as it was.'); return; }
    if (text === before.trim()) { cancelEdit(); return; }
    setEditSaving(true); setEditError('');
    // Filtered to your own internal note, so a row that is not yours comes back empty
    // rather than being changed. The database stamps edited_at itself.
    const { data, error } = await supabase.from('crm_activities')
      .update({ body: text })
      .eq('id', a.id).eq('actor_id', profile.id).eq('type', 'note').eq('is_internal', true)
      .select('id, body, edited_at');
    const row = Array.isArray(data) ? data[0] : null;
    if (error || !row) {
      setEditSaving(false);
      setEditError(error ? `Could not save the edit: ${error.message}` : 'Could not save the edit. Only the person who wrote an internal note can change it.');
      return; // the draft stays in the box
    }
    setActivities(prev => prev.map(r => (r.id === row.id ? { ...r, ...row } : r)));
    // Notify only people mentioned for the first time in this edit.
    const added = addedMentions(before, text);
    if (added.length) {
      await supabase.from('mentions').insert(added.map(userId => ({
        activity_id: a.id, mentioned_user_id: userId, ticket_id: subjectType === 'ticket' ? subjectId : null,
      })));
    }
    setEditSaving(false);
    cancelEdit();
    load(); // also discards any refresh that started before the save
  };
  const onEditKeyDown = (e, a) => {
    if (isSendShortcut(e)) { e.preventDefault(); saveEdit(a); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
  };

  const input = "w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper placeholder-dim focus:outline-none focus:border-ember";

  // Scroll-back aids: jump to oldest/latest + a floating "Latest" pill, and
  // sticky day dividers between messages from different days.
  const [showJump, setShowJump] = useState(false);
  const scrollToBottom = () => jumpToLatest(true);
  const scrollToTop = () => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  const onListScroll = (e) => {
    const el = e.target;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = gap < NEAR_BOTTOM_PX;
    setShowJump(gap > 260);
    if (gap < NEAR_BOTTOM_PX) setUnseen(0); // scrolled down to them: nothing unread below
  };
  const dayKeyOf = (ts) => new Date(ts).toDateString();
  const dayLabelOf = (ts) => {
    const d = new Date(ts), t = new Date(), y = new Date(); y.setDate(t.getDate() - 1);
    if (d.toDateString() === t.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Conversation header — count + jump-to-oldest/latest. The title is
          dropped on phones, where the tab above already says "Conversation". */}
      <div className="flex items-center gap-2 px-3 lg:px-4 py-1.5 lg:py-2.5 border-b border-bdr shrink-0">
        <h3 className="hidden lg:block text-sm font-bold text-paper">Conversation</h3>
        <span className="text-[10px] font-mono text-dim bg-card px-2 py-0.5 rounded-full">{activities.length} {activities.length === 1 ? 'message' : 'messages'}</span>
        {/* ml-auto rather than a flex-1 spacer: the global ≤640px rule gives any
            .flex-1 inside a bordered header a 100% basis, which pushed these
            onto a second row on a phone. */}
        {activities.length > 1 && (
          <>
            <button onClick={scrollToTop} title="Jump to oldest" className="ml-auto px-2.5 py-1 rounded-lg text-[11px] font-semibold text-muted hover:text-paper hover:bg-card transition">↑ Oldest</button>
            <button onClick={scrollToBottom} title="Jump to latest" className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-muted hover:text-paper hover:bg-card transition">↓ Latest</button>
          </>
        )}
      </div>
      {/* Messages */}
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div ref={scrollRef} onScroll={onListScroll} className="flex-1 overflow-y-auto overscroll-contain px-3 lg:px-4 py-3 lg:py-4">
      {/* Inner wrapper only so a ResizeObserver can see the rows grow. */}
      <div ref={contentRef} className="space-y-3">
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
              <div className={`max-w-[92%] lg:max-w-[80%] ${
                isNote
                  ? 'w-full'
                  : isOutbound
                  ? ''
                  : ''
              }`}>
                {/* Note / Internal */}
                {isNote && (
                  <div className={`rounded-2xl p-3 ${a.is_internal ? 'bg-amber-500/10 border border-amber-500/30' : 'glass-card'}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="w-5 h-5 rounded-full bg-amber-200 text-amber-800 text-[9px] font-bold flex items-center justify-center">{getInitial(a.actor_id)}</span>
                      <span className="text-xs font-medium text-paper">{getName(a.actor_id)}</span>
                      {a.is_internal && <span className="text-[9px] text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded font-bold uppercase">Internal</span>}
                      {a.edited_at && <span className="text-[10px] text-dim italic cursor-default" title={`Edited ${fmtStamp(a.edited_at)}`}>edited</span>}
                      <span className="text-[10px] text-dim ml-auto">{timeAgo(a.occurred_at)}</span>
                      {canEditNote(a) && editingId !== a.id && (
                        <button type="button" onClick={() => startEdit(a)} title="Edit your note"
                          className="px-1.5 py-0.5 -my-0.5 rounded-md text-[10px] font-semibold text-muted hover:text-paper hover:bg-card transition">Edit</button>
                      )}
                    </div>
                    {editingId === a.id ? (
                      <div>
                        <textarea
                          autoFocus
                          className={input + ' resize-y leading-relaxed'}
                          rows={Math.min(12, Math.max(3, editDraft.split('\n').length + 1))}
                          value={editDraft}
                          onChange={e => { setEditDraft(e.target.value); if (editError) setEditError(''); }}
                          onKeyDown={e => onEditKeyDown(e, a)}
                          onFocus={e => { const n = e.target.value.length; e.target.setSelectionRange(n, n); }}
                          readOnly={editSaving}
                        />
                        {editError && <div className="text-[11px] text-red-600 mt-1">{editError}</div>}
                        <div className="flex items-center gap-2 mt-2">
                          <button type="button" onClick={() => saveEdit(a)} disabled={editSaving || !editDraft.trim()}
                            className="btn-glass px-3 py-1.5 rounded-xl text-xs disabled:opacity-50">{editSaving ? 'Saving...' : 'Save'}</button>
                          <button type="button" onClick={cancelEdit} disabled={editSaving}
                            className="px-3 py-1.5 rounded-xl text-xs text-muted border border-bdr hover:text-paper">Cancel</button>
                          <span className="hidden lg:inline text-[10px] text-dim ml-auto">{shortcut} to save, Esc to cancel</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-paper leading-relaxed whitespace-pre-wrap">{renderBody(a.body)}</div>
                    )}
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
                    <div className={`rounded-2xl p-3 w-full ${isVoicemail ? 'bg-amber-500/10 border border-amber-500/30' : 'glass-card'}`}>
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
                      ? 'bg-emerald-500/10 border border-emerald-500/30'
                      : 'bg-blue-500/10 border border-blue-500/30'
                  }`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-sm">{TYPE_ICON[a.type]}</span>
                      <span className="text-xs font-medium text-paper">
                        {isAgent ? getName(a.actor_id) : (a.channel_metadata?.from || a.channel_metadata?.from_number || a.channel_metadata?.author || 'Customer')}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                        isOutbound ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                      }`}>{TYPE_LABEL[a.type]} {isOutbound ? 'sent' : 'received'}</span>
                      <span className="text-[10px] text-dim ml-auto">{timeAgo(a.occurred_at)}</span>
                    </div>
                    {a.subject && <div className="text-xs font-medium text-paper mb-1">{a.subject}</div>}
                    {(() => {
                      // Who it went to and who was copied, so a CC'd person is visible on the thread.
                      const f = fetchedHeaders[a.id];
                      const toLine = formatAddresses(f ? f.to : a.channel_metadata?.to);
                      const ccLine = formatAddresses(f ? f.cc : a.channel_metadata?.cc);
                      if (!toLine && !ccLine) return null;
                      return (
                        <div className="text-[10px] text-muted mb-1 break-words">
                          {toLine && <div>To: {toLine}</div>}
                          {ccLine && <div>Cc: {ccLine}</div>}
                        </div>
                      );
                    })()}
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
      </div>
      {(showJump || unseen > 0) && (
        <button onClick={scrollToBottom} className="absolute bottom-3 right-4 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card text-ember-deep border border-bdr text-xs font-semibold shadow-md hover:bg-ember/10 transition">
          ↓ Latest
          {unseen > 0 && <span className="px-1.5 py-0.5 rounded-full bg-ember text-white text-[10px] font-bold leading-none">{unseen} new</span>}
        </button>
      )}
      </div>

      {/* Composer */}
      {canWrite && (
        <div className="conv-composer border-t border-bdr px-3 lg:px-4 py-2 lg:py-3 shrink-0"
          style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}>
          {/* Channel indicator + tabs. The "contacted via" line is desktop-only —
              on a phone that row is height the reply box needs, and the same
              detail sits one tap away under Details. */}
          {ticketChannel && ticketChannel !== 'web' && (
            <div className="hidden lg:flex items-center gap-2 mb-2 px-1">
              <span className="text-[10px] text-muted">Customer contacted via</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase rounded-lg ${
                ticketChannel === 'sms' ? 'bg-blue-100 text-blue-700' : ticketChannel === 'email' ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'
              }`}>{TYPE_ICON[ticketChannel]} {ticketChannel}</span>
              {ticket?.customer_phone && <span className="text-[10px] text-muted">{ticket.customer_phone}</span>}
              {ticket?.customer_email && <span className="text-[10px] text-muted">{ticket.customer_email}</span>}
            </div>
          )}
          <div className="flex gap-1 mb-2 lg:mb-3">
            {(chatSession ? [{ key: 'chat', label: 'Chat', icon: '\u{1F4AD}' }, ...CHANNEL_TABS] : CHANNEL_TABS).map(t => (
              <button key={t.key} onClick={() => {
                setChannel(t.key);
                // Auto-fill customer contact from ticket. Email To/Cc already
                // follow the thread and keep any hand edits across tab switches.
                if (t.key === 'sms' && ticket?.customer_phone) setToPhone(ticket.customer_phone);
              }}
                className={`flex items-center gap-1 lg:gap-1.5 px-2 lg:px-3 py-1.5 text-[11px] lg:text-xs font-medium rounded-xl transition ${
                  channel === t.key ? 'bg-ember text-white'
                  : t.key === ticketChannel ? 'bg-ember/10 text-ember border border-ember/20'
                  : 'bg-card text-muted hover:text-paper'
                }`}>
                <span>{t.icon}</span> {t.label}
                {t.key === ticketChannel && t.key !== 'note' && <span className="text-[8px] ml-0.5">*</span>}
              </button>
            ))}

            {/* Right-aligned tools: attach (email) + AI draft + Templates.
                Icon-only on phones so all four channel tabs still fit one row. */}
            <div className="ml-auto flex items-center gap-1">
            {subjectType === 'ticket' && channel === 'email' && (
              <>
                <button onClick={() => attachRef.current?.click()} title="Attach image"
                  className="flex items-center gap-1 px-2 lg:px-3 py-1.5 text-[11px] lg:text-xs font-medium rounded-xl bg-card text-muted hover:text-paper transition">
                  {'\u{1F4CE}'} <span className="hidden sm:inline">Attach</span>
                </button>
                <input ref={attachRef} type="file" accept="image/*,.pdf" multiple className="hidden" onChange={onPickAttach} />
              </>
            )}
            {channel === 'chat' && chatSession && (
              <button onClick={async () => {
                if (!confirm('End this chat? The customer\u2019s chat window will show the conversation as closed.')) return;
                await supabase.from('chat_sessions').update({ status: 'closed', last_at: new Date().toISOString() }).eq('id', chatSession.id);
                // system: written by the app, not typed by the agent, so it gets no Edit.
                await supabase.from('crm_activities').insert({
                  type: 'note', body: 'Chat ended by ' + (profile.display_name || 'agent') + '.',
                  subject_type: 'ticket', subject_id: subjectId, actor_id: profile.id, is_internal: true, channel_metadata: { system: true },
                });
                setChatSession(null);
                setChannel('note');
                load();
              }}
                className="flex items-center gap-1 px-2 lg:px-3 py-1.5 text-[11px] lg:text-xs font-semibold rounded-xl bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition">
                {'\u2715'} <span className="hidden sm:inline">End chat</span>
              </button>
            )}
            {subjectType === 'ticket' && channel !== 'call' && (
              <button onClick={generateDraft} disabled={aiLoading} title="AI reply"
                className="flex items-center gap-1 px-2 lg:px-3 py-1.5 text-[11px] lg:text-xs font-semibold rounded-xl bg-ember/15 text-ember-deep border border-ember/25 hover:bg-ember/25 disabled:opacity-50">
                {aiLoading ? <>✨ <span className="hidden sm:inline">Generating…</span></> : <>✨ <span className="hidden sm:inline">AI reply</span></>}
              </button>
            )}
            {/* Templates picker */}
            {channel !== 'call' && availableTemplates.length > 0 && (
              <div className="relative">
                <button onClick={() => setShowTemplates(v => !v)} title="Templates"
                  className="flex items-center gap-1 px-2 lg:px-3 py-1.5 text-[11px] lg:text-xs font-medium rounded-xl bg-card text-muted hover:text-paper transition">
                  {'\u{1F4C4}'} <span className="hidden sm:inline">Templates</span> {'\u{25BE}'}
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
              {/* Reply or Reply all: only offered when Reply all would reach
                  someone extra. Picking one puts To and Cc back to its defaults. */}
              {canReplyAll && (
                <div className="flex items-center gap-1" role="group" aria-label="Reply or reply all">
                  {[['reply', 'Reply'], ['all', 'Reply all']].map(([m, l]) => (
                    <button key={m} type="button" onClick={() => chooseReplyMode(m)} aria-pressed={replyMode === m}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition ${
                        replyMode === m ? 'bg-ember/15 text-ember-deep border-ember/25' : 'bg-card text-muted border-bdr hover:text-paper'
                      }`}>{l}</button>
                  ))}
                </div>
              )}
              {newerEmailWaiting && (
                <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-paper">
                  <span className="flex-1 min-w-0">A newer email came in while you were writing. This reply still goes to the people below.</span>
                  <button type="button" onClick={() => resetRecipients()} className="shrink-0 font-semibold text-ember-deep hover:underline">Reply to newest</button>
                </div>
              )}
              {/* Phones: who it goes to is a single line you tap to change, rather
                  than full-width fields competing with the message box. */}
              <button type="button" onClick={() => setEditTo(v => !v)}
                className="lg:hidden w-full flex items-center gap-2 px-3 py-1.5 rounded-xl bg-card border border-bdr text-left">
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-dim shrink-0">To</span>
                <span className="flex-1 min-w-0 truncate text-xs text-paper">
                  {toList.length ? toList.map(a => a.email).join(', ') : (toPending || 'Add an address')}
                  {ccList.length > 0 && <span className="text-muted">{`, Cc ${ccList.length}`}</span>}
                </span>
                <span className="text-[10px] text-muted shrink-0">{editTo ? 'Done' : 'Change'}</span>
              </button>
              <div className={`${editTo ? 'block' : 'hidden'} lg:block space-y-2`}>
                <AddressInput key={`to-${recipientsVersion}`} label="To" value={toList}
                  onChange={list => { touchRecipients(); setToList(list); }}
                  onPendingChange={t => { if (t) touchRecipients(); else setSendError(''); setToPending(t); }}
                  placeholder="Add an email address" />
                {showCc ? (
                  <AddressInput key={`cc-${recipientsVersion}`} label="Cc" value={ccList}
                    onChange={list => { touchRecipients(); setCcList(list); }}
                    onPendingChange={t => { if (t) touchRecipients(); else setSendError(''); setCcPending(t); }}
                    placeholder="Copy someone in" />
                ) : (
                  <button type="button" onClick={() => setShowCc(true)}
                    className="px-1 text-[11px] font-semibold text-muted hover:text-paper">+ Cc</button>
                )}
              </div>
              {sendError && <div className="text-[11px] text-red-600 px-1">{sendError}</div>}
              {(sigPool.names || []).filter(Boolean).length > 0
                ? <div className="hidden lg:block text-[10px] text-dim px-1">Signed by one of {(sigPool.names || []).filter(Boolean).length} support names, picked at random (Settings &rarr; Support).</div>
                : mySignature && <div className="hidden lg:block text-[10px] text-dim px-1">Your signature will be added automatically (edit it under Account).</div>}
              {pendingFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pendingFiles.map((p, i) => (
                    <span key={i} className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-lg bg-ember/10 text-ember-deep text-[11px] font-medium border border-ember/20">
                      {'\u{1F4CE}'} <span className="max-w-[140px] truncate">{p.name}</span>
                      <button onClick={() => removePending(i)} className="w-4 h-4 rounded hover:bg-ember/20 text-ember-deep" title="Remove">{'\u{00D7}'}</button>
                    </span>
                  ))}
                </div>
              )}
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
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
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
              className={input + ' resize-none pr-20 lg:min-h-[110px]'}
              rows={3}
              value={body}
              onChange={handleBodyChange}
              onKeyDown={onComposerKeyDown}
              placeholder={
                channel === 'note' ? 'Add a note... type @ to mention a team member'
                : channel === 'email' ? 'Email body...'
                : channel === 'sms' ? `SMS message... (${body.length}/160 chars)`
                : channel === 'chat' ? 'Reply in the customer\u2019s chat window...'
                : 'Call notes...'
              }
            />

            {/* @mention dropdown */}
            {showMentions && filteredMembers.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-64 menu-surface rounded-xl overflow-hidden shadow-lg z-10 max-h-40 overflow-y-auto">
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

            {/* Replies on a ticket force a status choice; notes/calls save directly. */}
            <button
              onClick={() => submitComposer({ toggle: true })}
              disabled={sending || (!body.trim() && channel !== 'call')}
              className="absolute bottom-2 right-2 btn-glass px-4 py-2 lg:py-1.5 rounded-xl text-xs disabled:opacity-50">
              {sending ? '...' : channel === 'note' ? 'Add' : channel === 'call' ? 'Log' : 'Send'}
            </button>
            {/* Desktop hint for the shortcut, in the textarea's right-hand gutter above the button. */}
            <div className="hidden lg:block absolute right-2 bottom-10 w-16 text-center text-[10px] text-dim pointer-events-none select-none">{shortcut}</div>
            {/* Status picker: a popover on desktop, a bottom sheet on phones —
                anchored to the button it was drawn off the bottom of the screen. */}
            {askStatus && (
              <>
                <div className="lg:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setAskStatus(false)} />
                <div className="fixed inset-x-3 bottom-3 z-50 lg:absolute lg:inset-x-auto lg:bottom-11 lg:right-2 lg:z-30 lg:w-60 menu-surface rounded-2xl lg:rounded-xl shadow-xl overflow-hidden"
                  style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
                  <div className="px-3 py-2 text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim border-b border-bdr">Send &amp; set ticket status</div>
                  {TICKET_STAGES.map(s => (
                    <button key={s} onClick={() => { setAskStatus(false); save(s); }}
                      className="w-full px-4 lg:px-3 py-3 lg:py-2 text-left text-sm text-paper hover:bg-ember/10 border-b border-bdr last:border-b-0 lg:border-b-0 flex items-center justify-between transition">
                      <span>{TICKET_STAGE_LABELS[s]}</span>
                      {ticket?.stage === s && <span className="text-[10px] font-mono text-dim">current</span>}
                    </button>
                  ))}
                  <button onClick={() => setAskStatus(false)}
                    className="lg:hidden w-full px-4 py-3 text-center text-sm font-semibold text-muted">Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function fmtStamp(ts) {
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  const d = (Date.now() - new Date(ts).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  if (d < 2592000) return Math.floor(d / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}
