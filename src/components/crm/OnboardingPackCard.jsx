import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import {
  GROUPS, formContext, visibleSections, visibleFields, titleOf, labelOf, optionLabel,
  formatOf, formatDob, isEmpty, progress, regionFor, representativeName, heldEntryOf,
} from '../../lib/onboardingForm';

// The onboarding pack, from our side: send it, chase it, read it.
//
// Deliberately shows the state of the thing rather than just a button — sent
// when, opened or not, completed when — because "have they filled it in yet" is
// the question this card exists to answer.
//
// Bank numbers, date of birth, home address and photo ID are never in the
// answers this card reads (every logged in user can read those). The answers
// only carry _held, which says a detail is there, so everyone sees "Held
// securely" and nothing more. The owner can look at one detail at a time,
// straight from onboarding_form_secure and the onboarding-secure bucket, which
// RLS lets only the owner read (migration 114). Every look leaves a note on the
// onboarding saying who, never what.

// Same bucket as SECURE_BUCKET in supabase/functions/_shared/onboardingSecure.ts.
// Written out here so the staff bundle does not reach into the edge functions.
const SECURE_BUCKET = 'onboarding-secure';
// Long enough to read a sort code out to a payment provider, short enough that
// a screen left open does not keep showing it.
const REVEAL_MS = 30 * 1000;
// Long enough to open the file, too short for a copied link to be any use later.
const SIGNED_URL_SECONDS = 60;

const REGION_NOTE = {
  UK: 'Asks UK questions: Companies House, VAT and sort code.',
  US: 'Asks US questions: EIN and routing number.',
};

export default function OnboardingPackCard({ onboarding, company, location, locations = [], contacts = [], profile, onChanged }) {
  const [req, setReq] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [email, setEmail] = useState('');
  const [open, setOpen] = useState(false);
  // Sensitive answers (the WiFi password) stay hidden until asked for, one at a
  // time, so showing one never shows the others.
  const [unmasked, setUnmasked] = useState({});
  // Secure values the owner has asked to see, keyed 'section.field'. Each one
  // masks itself again after REVEAL_MS.
  const [revealed, setRevealed] = useState({});
  const [busy, setBusy] = useState('');            // the key being fetched, or 'purge'
  // Owner only: { row, purged_at, objects }, never the values. objects counts
  // everything in the pack's folder in the bucket, so an ID uploaded and never
  // saved still shows, and can still be deleted.
  const [secureRow, setSecureRow] = useState(null);
  const timers = useRef({});
  // The onboarding and request this card shows right now. The card is reused
  // when someone moves from one onboarding to the next, so anything that
  // lands after an await checks these first: a Show that returns late must
  // never put one customer's sort code on the next customer's card.
  const onbRef = useRef(onboarding.id);
  const reqRef = useRef(null);
  // The venue this job is for. Most onboardings sit under a partner company
  // with dozens of venues, so without this the menu and table plan would land
  // on the partner and tell us nothing about the site being installed.
  const [venueId, setVenueId] = useState(onboarding.location_id || '');
  useEffect(() => { setVenueId(onboarding.location_id || ''); }, [onboarding.location_id]);
  const canWrite = profile.role === 'owner' || profile.role === 'editor';
  const isOwner = profile.role === 'owner';
  const byName = profile.display_name || profile.email || 'the owner';

  // Unmount only. The object is mutated, never replaced, so the one captured
  // here is the one the timers are stored in.
  useEffect(() => {
    const t = timers.current;
    return () => { Object.values(t).forEach(clearTimeout); };
  }, []);

  const hideSecure = (key) => {
    clearTimeout(timers.current[key]);
    delete timers.current[key];
    setRevealed(r => { const next = { ...r }; delete next[key]; return next; });
  };
  const hideAllSecure = () => {
    for (const k of Object.keys(timers.current)) { clearTimeout(timers.current[k]); delete timers.current[k]; }
    setRevealed({});
  };

  const load = async () => {
    const onbId = onbRef.current;
    const { data } = await supabase.from('onboarding_form_requests')
      .select('*').eq('onboarding_id', onbId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (onbRef.current !== onbId) return;
    reqRef.current = data?.id || null;
    setReq(data || null);
    setLoaded(true);
    if (!data || !isOwner) { setSecureRow(null); return; }
    // Only whether the details were deleted, so the owner sees when. RLS gives
    // anyone else no row, and the values are not selected even for the owner.
    const { data: sec } = await supabase.from('onboarding_form_secure')
      .select('purged_at').eq('request_id', data.id).maybeSingle();
    let objects = 0;
    try {
      const { data: listed } = await supabase.storage.from(SECURE_BUCKET).list(data.id, { limit: 100 });
      // Folders come back with no id.
      objects = (listed || []).filter(o => o?.name && o.id !== null).length;
    } catch { /* the count only decides whether to offer Delete */ }
    if (reqRef.current !== data.id) return;
    setSecureRow(sec || objects ? { row: !!sec, purged_at: sec?.purged_at || null, objects } : null);
  };

  // A different onboarding: nothing revealed, open or half fetched carries over.
  useEffect(() => {
    onbRef.current = onboarding.id;
    reqRef.current = null;
    hideAllSecure();
    setOpen(false);
    setUnmasked({});
    setSecureRow(null);
    setBusy('');
    setReq(null);
    setLoaded(false);
    load();
  }, [onboarding.id]);

  useEffect(() => {
    if (email) return;
    const c = contacts.find(x => x.email);
    if (c?.email) setEmail(c.email);
  }, [contacts]);

  const send = async () => {
    if (!email.includes('@')) { alert('Add the email address to send it to.'); return; }
    if (!venueId) { alert('Choose which venue this onboarding is for first. The menu, table plan and logo attach to that venue.'); return; }
    setSending(true);
    try {
      // Pin the job to the venue before sending. Doing it here (rather than
      // only on the pack) means the onboarding itself is finally correct too,
      // so every other screen stops showing the partner instead of the site.
      if (onboarding.location_id !== venueId) {
        const { error } = await supabase.from('onboardings').update({ location_id: venueId }).eq('id', onboarding.id);
        if (error) { alert('Could not set the venue: ' + error.message); setSending(false); return; }
      }
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/onboarding-form-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          onboarding_id: onboarding.id,
          location_id: venueId,
          company_id: onboarding.company_id || null,
          contact_id: contacts.find(c => c.email === email)?.id || null,
          contact_name: contacts.find(c => c.email === email)?.first_name || '',
          venue: (locations.find(l => l.id === venueId)?.name) || location?.name || '',
          to: email,
          app_url: window.location.origin,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not send');
      await load();
      onChanged?.();
      alert(d.link_replaced
        ? `Onboarding pack sent to ${d.sent_to}. It has a new link, so the one sent to the earlier address no longer works.`
        : `Onboarding pack sent to ${d.sent_to}.`);
    } catch (e) { alert(e.message); }
    setSending(false);
  };

  // Make the pack without sending anything: for when you want to paste the
  // link into WhatsApp, a text, or an email you are writing yourself.
  const createLink = async () => {
    if (!venueId) { alert('Choose which venue this onboarding is for first. The menu, table plan and logo attach to that venue.'); return; }
    setSending(true);
    try {
      if (onboarding.location_id !== venueId) {
        const { error } = await supabase.from('onboardings').update({ location_id: venueId }).eq('id', onboarding.id);
        if (error) throw error;
      }
      const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 40);
      const { error } = await supabase.from('onboarding_form_requests').insert({
        onboarding_id: onboarding.id, location_id: venueId,
        company_id: onboarding.company_id || null, token, created_by: profile.id,
      });
      if (error) throw error;
      await load();
      onChanged?.();
    } catch (e) { alert('Could not create the link: ' + e.message); }
    setSending(false);
  };

  // An internal note naming who looked or deleted, never the value:
  // crm_activities is readable by every logged in user. `f.label` is the plain
  // wording ("Legal representative date of birth"), which reads right in a log
  // whoever filled the pack in.
  // Always given the onboarding the detail came from, not whichever one the
  // card shows by the time the note is written.
  const note = (onbId, subject, body) => supabase.from('crm_activities').insert({
    type: 'note', subject_type: 'onboarding', subject_id: onbId, actor_id: profile.id,
    is_internal: true, subject, body: body || null,
    channel_metadata: { kind: 'onboarding_secure' },
  });

  // Owner only. One value, fetched when asked for and dropped again after
  // REVEAL_MS, so it is never sitting in the card's state.
  const showSecure = async (sec, f) => {
    const key = `${sec.key}.${f.key}`;
    const reqId = req.id;
    const onbId = onbRef.current;
    const stillHere = () => reqRef.current === reqId;
    setBusy(key);
    try {
      const { data, error } = await supabase.from('onboarding_form_secure')
        .select('secure_values').eq('request_id', reqId).maybeSingle();
      if (error) throw error;
      // Moved to another onboarding while this was loading: shown nowhere.
      if (!stillHere()) return;
      const value = data?.secure_values?.[key];
      if (value == null || !String(value).trim()) throw new Error('That detail is no longer held.');
      // Recorded before it is shown, so closing the card straight away still
      // leaves the trace. A failed note does not lock the owner out.
      await note(onbId, `${sec.key === 'bank' ? 'Bank' : 'ID'} details viewed by ${byName}`, `${f.label}.`);
      if (!stillHere()) return;
      setRevealed(r => ({ ...r, [key]: String(value) }));
      clearTimeout(timers.current[key]);
      timers.current[key] = setTimeout(() => hideSecure(key), REVEAL_MS);
    } catch (e) {
      if (stillHere()) alert('Could not show it: ' + e.message);
    } finally {
      if (stillHere()) setBusy('');
    }
  };

  // Owner only. The ID image opens from a short signed URL and is never
  // downloaded into the card.
  const viewFile = async (sec, f) => {
    const key = `${sec.key}.${f.key}`;
    const reqId = req.id;
    const onbId = onbRef.current;
    const stillHere = () => reqRef.current === reqId;
    // Open the tab inside the click, BEFORE any await, or the browser blocks it
    // as a popup and nothing happens. It is pointed at the signed URL below.
    const w = window.open('', '_blank');
    if (w) w.opener = null;
    setBusy(key);
    try {
      const { data, error } = await supabase.from('onboarding_form_secure')
        .select('files').eq('request_id', reqId).maybeSingle();
      if (error) throw error;
      const path = data?.files?.[key]?.path;
      if (!path) throw new Error('That file is no longer held.');
      const { data: signed, error: urlError } = await supabase.storage.from(SECURE_BUCKET)
        .createSignedUrl(path, SIGNED_URL_SECONDS);
      if (urlError || !signed?.signedUrl) throw urlError || new Error('Could not open the file.');
      if (!stillHere()) { if (w) w.close(); return; }
      await note(onbId, `ID details viewed by ${byName}`, `${f.label}.`);
      if (w) w.location.href = signed.signedUrl; else window.open(signed.signedUrl, '_blank');
    } catch (e) {
      if (w) w.close();
      if (stillHere()) alert('Could not open it: ' + e.message);
    } finally {
      if (stillHere()) setBusy('');
    }
  };

  // The customer's page may be saving at this moment, through the function,
  // which only writes if updated_at is still what it read. So: re-read, write
  // only if nothing changed in between, and move updated_at on, so a save
  // already in flight re-reads instead of putting the old _held back.
  const clearHeld = async (reqId) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data: cur, error } = await supabase.from('onboarding_form_requests')
        .select('answers, updated_at').eq('id', reqId).single();
      if (error) throw error;
      const { data: hit, error: writeError } = await supabase.from('onboarding_form_requests')
        .update({ answers: { ...(cur.answers || {}), _held: {} }, updated_at: new Date().toISOString() })
        .eq('id', reqId).eq('updated_at', cur.updated_at).select('id');
      if (writeError) throw writeError;
      if (hit?.length) return;
    }
    throw new Error('The pack is being saved by the customer right now. Try again in a moment.');
  };

  // Owner only. Files first: if removing them fails, the row still lists them
  // and the delete can be tried again. The whole of this request's folder goes,
  // not only the files the row lists, because an ID uploaded and never saved
  // (the page closed mid way) is still sitting there. The note is written as
  // soon as the details are gone, so a later step failing never leaves a
  // deletion with no record of who did it.
  const purge = async () => {
    if (!confirm('Delete the bank details, date of birth, home address and photo ID held on this pack?\n\nThis cannot be undone. The customer would have to give them again.')) return;
    const reqId = req.id;
    const onbId = onbRef.current;
    const stillHere = () => reqRef.current === reqId;
    let gone = false;
    setBusy('purge');
    try {
      const { data: row, error } = await supabase.from('onboarding_form_secure')
        .select('files').eq('request_id', reqId).maybeSingle();
      if (error) throw error;
      const bucket = supabase.storage.from(SECURE_BUCKET);
      const paths = new Set(Object.values(row?.files || {}).map(x => x?.path).filter(Boolean));
      try {
        const { data: listed } = await bucket.list(reqId, { limit: 1000 });
        for (const o of listed || []) if (o?.name && o.id !== null) paths.add(`${reqId}/${o.name}`);
      } catch { /* the listing only adds strays; the row's own paths are what must go */ }
      if (paths.size) {
        const { error: removeError } = await bucket.remove([...paths]);
        if (removeError) throw removeError;
      }
      const now = new Date().toISOString();
      const { error: rowError } = await supabase.from('onboarding_form_secure')
        .update({ secure_values: {}, files: {}, purged_at: now, purged_by: profile.id, updated_at: now })
        .eq('request_id', reqId);
      if (rowError) throw rowError;
      gone = true;
      if (stillHere()) hideAllSecure();
      await note(onbId, `ID and bank details deleted by ${byName}`);
      await clearHeld(reqId);
    } catch (e) {
      // Only the tidy of the pack's held list failed: the details themselves
      // are already deleted, and saying otherwise would send the owner looking.
      if (gone) alert('Deleted. The pack still lists them as held. Press Delete again to tidy it up.');
      else alert('Could not delete them: ' + e.message);
    } finally {
      if (stillHere()) {
        setBusy('');
        await load();
      }
    }
  };

  const toggleOpen = () => {
    if (open) hideAllSecure();
    setOpen(v => !v);
  };

  const link = req ? `${window.location.origin}/onboarding/${req.token}` : '';
  const answers = req?.answers || {};
  const done = !!req?.submitted_at;
  const fmt = (d) => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;

  // UK or US questions. A submitted pack is stamped with the region it was
  // answered in. One submitted before the stamp existed was answered on the UK
  // form, so it reads as UK whatever the venue says now. Anything not yet
  // submitted follows the venue, then the company, exactly as the function
  // does on every load and save. A stamp from an earlier save is not used for
  // it: sending the pack again can move it to another venue, and the customer
  // is then asked that venue's questions.
  const reqVenue = locations.find(l => l.id === req?.location_id) || location;
  const ctx = formContext(answers, {
    region: done ? (answers._meta?.region || 'UK') : regionFor(reqVenue?.country, company?.country),
    held: answers._held,
  });
  const heldCount = Object.values(ctx.held || {}).filter(Boolean).length;
  const customerSaved = Object.keys(answers).some(k => !k.startsWith('_'));
  // The function stamps each customer save on _meta. updated_at also moves
  // when the pack is emailed, so it is only the fallback, for packs saved
  // before the stamp, and only once the customer has answered something.
  const lastSaved = answers._meta?.saved_at || (customerSaved ? req?.updated_at : null);
  const answered = progress(answers, ctx);
  const repName = representativeName(answers);

  // A secure question shows when something is held for it, and never shows a
  // value that somehow reached the answers: that would be a bug, not an answer.
  // A card face held for a different ID type does not count (heldEntryOf).
  const hasAnswer = (sec, f) => (f.secure ? !!heldEntryOf(sec, f, ctx) : !isEmpty(f, (answers[sec.key] || {})[f.key]));
  const strayObjects = isOwner ? secureRow?.objects || 0 : 0;

  const renderAnswer = (sec, f) => {
    const key = `${sec.key}.${f.key}`;
    const v = (answers[sec.key] || {})[f.key];
    const label = labelOf(f, ctx);

    if (f.secure) {
      const hint = ctx.held?.[key]?.hint;
      const shown = revealed[key];
      return (
        <div key={f.key} className="text-xs">
          <div className="text-muted">{label}</div>
          <div className="flex items-start gap-2">
            {shown != null ? (
              <span className={`text-paper whitespace-pre-wrap ${f.type === 'textarea' ? '' : 'font-mono'}`}>
                {f.type === 'dob' ? formatDob(shown, ctx) : formatOf(f, shown, ctx)}
              </span>
            ) : (
              <span className="text-paper">{hint ? `Held securely, ending ${hint}` : 'Held securely'}</span>
            )}
            {isOwner && (f.type === 'file' ? (
              <button disabled={!!busy} onClick={() => viewFile(sec, f)} className="text-[10px] text-ember hover:underline disabled:opacity-50 shrink-0">
                {busy === key ? 'Opening…' : 'View'}
              </button>
            ) : shown != null ? (
              <button onClick={() => hideSecure(key)} className="text-[10px] text-ember hover:underline shrink-0">Hide</button>
            ) : (
              <button disabled={!!busy} onClick={() => showSecure(sec, f)} className="text-[10px] text-ember hover:underline disabled:opacity-50 shrink-0">
                {busy === key ? 'Loading…' : 'Show'}
              </button>
            ))}
          </div>
        </div>
      );
    }

    if (f.type === 'confirm') {
      return (
        <div key={f.key} className="text-xs flex gap-1.5">
          <span className="text-emerald-600 font-bold shrink-0">✓</span>
          <span className="text-paper">{label}</span>
        </div>
      );
    }
    if (f.type === 'file') {
      const files = Array.isArray(v) ? v : [v];
      return (
        <div key={f.key} className="text-xs">
          <div className="text-muted">{label}</div>
          <div className="space-y-0.5 mt-0.5">
            {files.map(file => (
              <div key={file.path} className="text-paper">📎 {file.name}
                <span className="text-dim ml-1 font-mono text-[10px]">{(file.size / 1048576).toFixed(1)}MB</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    if (f.sensitive) {
      return (
        <div key={f.key} className="text-xs">
          <div className="text-muted">{label}</div>
          <div className="text-paper font-mono flex items-center gap-2">
            <span>{unmasked[key] ? String(v) : '••••••••••'}</span>
            <button onClick={() => setUnmasked(m => ({ ...m, [key]: !m[key] }))} className="text-[10px] text-ember hover:underline">
              {unmasked[key] ? 'hide' : 'show'}
            </button>
          </div>
        </div>
      );
    }
    return (
      <div key={f.key} className="text-xs">
        <div className="text-muted">{label}</div>
        <div className="text-paper whitespace-pre-wrap">
          {f.type === 'choice' ? optionLabel(f, v, ctx) : formatOf(f, v, ctx)}
        </div>
      </div>
    );
  };

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-bdr flex items-center gap-2">
        <h3 className="text-sm font-bold text-paper">Onboarding pack</h3>
        {req && (
          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
            done ? 'bg-emerald-100 text-emerald-700' : req.opened_at ? 'bg-blue-100 text-blue-700' : 'bg-amber/15 text-amber'}`}>
            {done ? 'Completed' : req.opened_at ? 'Opened' : 'Sent'}
          </span>
        )}
        {done && <button onClick={toggleOpen} className="ml-auto text-xs text-ember hover:text-ember-deep font-medium">{open ? 'Hide' : 'View answers'}</button>}
      </div>

      <div className="p-4 space-y-3">
        {!loaded ? <div className="text-xs text-dim italic">Loading…</div> : !req ? (
          <>
            <div className="text-xs text-muted">
              Send the customer everything we need to build their till: company and trading details, VAT, receipt logo,
              menu, users, discounts, table plan, how their kitchen tickets should print, plus the site checks and
              pre-install jobs. Everything they upload attaches to the venue below.
            </div>
            <VenuePicker {...{ venueId, setVenueId, locations, canWrite, company }} />
            {canWrite && (
              <>
                <div className="flex gap-2">
                  <input className="flex-1 px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper" placeholder="customer@venue.co.uk"
                    value={email} onChange={e => setEmail(e.target.value)} />
                  <button disabled={sending} onClick={send} className="btn-glass px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50 whitespace-nowrap">
                    {sending ? 'Sending…' : 'Email it'}
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-dim">or</span>
                  <button disabled={sending} onClick={createLink}
                    className="btn-ghost px-3 py-1.5 rounded-xl text-xs font-semibold disabled:opacity-50">
                    Just create a link to copy
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <>
            {done && answers.signoff?.agreed === true && (
              <div className="px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200">
                <div className="text-[11px] font-bold text-emerald-800">
                  Signed off by {answers.signoff.full_name || 'unnamed'}
                  {answers.signoff.position ? `, ${answers.signoff.position}` : ''}
                </div>
                <div className="text-[10px] text-emerald-700 mt-0.5">
                  Accepted our terms on {fmt(req.submitted_at)}
                </div>
              </div>
            )}

            <div className="space-y-1 text-xs">
              <Row k="Venue" v={locations.find(l => l.id === req.location_id)?.name || (req.location_id ? '—' : 'NOT SET')} />
              <Row k="Sent to" v={req.sent_to || 'link only, not emailed'} />
              <Row k="Sent" v={fmt(req.sent_at) || 'not emailed'} />
              <Row k="Opened" v={fmt(req.opened_at) || 'not yet'} />
              <Row k="Completed" v={fmt(req.submitted_at) || 'not yet'} />
              {!done && (
                <>
                  <Row k="Last saved" v={fmt(lastSaved) || 'not yet'} />
                  <Row k="Progress" v={`${answered.done} of ${answered.required} answered`} />
                </>
              )}
              {(heldCount > 0 || (isOwner && secureRow)) && (
                <Row k="ID and bank details"
                  v={heldCount > 0 ? 'Held securely'
                    : strayObjects > 0 ? 'An ID upload that was never saved is held'
                      : secureRow?.purged_at ? `Deleted ${fmt(secureRow.purged_at)}` : 'Nothing held'} />
              )}
            </div>

            {!done && <div className="text-[10px] text-dim">{REGION_NOTE[ctx.region]}</div>}

            {isOwner && (heldCount > 0 || strayObjects > 0 || (secureRow?.row && !secureRow.purged_at)) && (
              <div className="flex justify-end">
                <button disabled={!!busy} onClick={purge}
                  className="text-[11px] text-red-600 hover:underline font-semibold disabled:opacity-50">
                  {busy === 'purge' ? 'Deleting…' : 'Delete ID and bank details'}
                </button>
              </div>
            )}

            <div className="flex items-center gap-2">
              <input readOnly value={link} onFocus={e => e.target.select()}
                className="flex-1 px-2 py-1.5 bg-card border border-bdr rounded-lg text-[10px] font-mono text-muted" />
              <button onClick={() => { navigator.clipboard.writeText(link); alert('Link copied'); }}
                className="btn-ghost px-2 py-1.5 rounded-lg text-xs shrink-0">Copy</button>
            </div>

            {!done && canWrite && (
              <div className="flex gap-2 items-center flex-wrap">
                <input className="flex-1 min-w-[180px] px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper"
                  placeholder="customer@venue.co.uk" value={email} onChange={e => setEmail(e.target.value)} />
                <button disabled={sending} onClick={send} className="btn-ghost px-3 py-2 rounded-xl text-xs font-semibold disabled:opacity-50 whitespace-nowrap">
                  {sending ? 'Sending…' : req.sent_at ? 'Email it again' : 'Email it'}
                </button>
              </div>
            )}

            {done && open && (
              <div className="space-y-4 pt-2 border-t border-bdr max-h-[460px] overflow-y-auto">
                {GROUPS.map(g => {
                  const secs = visibleSections(g.key, answers, ctx)
                    .map(sec => ({ sec, rows: visibleFields(sec, answers, ctx).filter(f => hasAnswer(sec, f)) }))
                    .filter(x => x.rows.length);
                  if (!secs.length) return null;
                  return (
                    <div key={g.key}>
                      <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-ember mb-1.5">{g.title}</div>
                      <div className="space-y-3">
                        {secs.map(({ sec, rows }) => (
                          <div key={sec.key}>
                            <div className="text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-dim mb-1">{titleOf(sec, ctx)}</div>
                            <div className="space-y-1.5">
                              {/* Worked out, not stored: the main contact or the sole
                                  trader themselves. Skipped when the name was typed
                                  in below, which already says it. */}
                              {sec.key === 'representative' && repName && !rows.some(f => f.key === 'name') && (
                                <div className="text-xs">
                                  <div className="text-muted">Legal representative</div>
                                  <div className="text-paper">{repName}</div>
                                </div>
                              )}
                              {rows.map(f => renderAnswer(sec, f))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
                <div className="text-[10px] text-dim pt-1">Menu, logo and table plan are on this venue's Attachments. ID and bank details stay on this pack.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function VenuePicker({ venueId, setVenueId, locations, canWrite, company }) {
  if (!canWrite) return null;
  const venue = locations.find(l => l.id === venueId);
  return (
    <div>
      <label className="text-[10px] font-mono font-bold uppercase tracking-[0.18em] text-dim mb-1 block">
        Venue being onboarded
      </label>
      <select className="w-full px-3 py-2 bg-card border border-bdr rounded-xl text-sm text-paper"
        value={venueId} onChange={e => setVenueId(e.target.value)}>
        <option value="">Choose the venue</option>
        {locations.map(l => <option key={l.id} value={l.id}>{l.name}{l.city ? ` · ${l.city}` : ''}</option>)}
      </select>
      {!venueId ? (
        <div className="text-[10px] text-amber mt-1">
          Required. Their menu, logo and table plan attach here, so it must be the site being installed, not the group.
        </div>
      ) : (
        // The same rule the function uses to pick the questions, so what we
        // say here is what the customer gets.
        <div className="text-[10px] text-dim mt-1">{REGION_NOTE[regionFor(venue?.country, company?.country)]}</div>
      )}
    </div>
  );
}

function Row({ k, v }) {
  return <div className="flex justify-between gap-3"><span className="text-dim">{k}</span><span className="text-paper text-right truncate">{v || '—'}</span></div>;
}
