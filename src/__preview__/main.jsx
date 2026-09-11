import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import TodayPanel from '../components/crm/TodayPanel.jsx';
import TaskDetail from '../components/crm/TaskDetail.jsx';
import TicketDetail from '../components/crm/TicketDetail.jsx';
import ProjectDetail from '../components/crm/ProjectDetail.jsx';
import ProjectList from '../components/crm/ProjectList.jsx';
import TaskList from '../components/crm/TaskList.jsx';
import Timeline from '../components/crm/Timeline.jsx';
import WorkCalendar from '../components/crm/WorkCalendar.jsx';
import WorkBoard from '../components/crm/WorkBoard.jsx';
import BillsPanel from '../components/finance/BillsPanel.jsx';
import QuoteBuilder from '../components/crm/QuoteBuilder.jsx';
import MobileInbox from '../components/crm/MobileInbox.jsx';
import CallLogPanel from '../components/crm/CallLogPanel.jsx';
import LeadDetail from '../components/crm/LeadDetail.jsx';
import DealDetail from '../components/crm/DealDetail.jsx';
import PaymentsPanel from '../components/crm/PaymentsPanel.jsx';
import ReportingDashboard from '../components/crm/ReportingDashboard.jsx';
import LocationDetail from '../components/crm/LocationDetail.jsx';
import ExpensesPanel from '../components/finance/ExpensesPanel.jsx';
import WhatIOwePanel from '../components/finance/WhatIOwePanel.jsx';
import ProductsPanel from '../components/crm/ProductsPanel.jsx';
import QuotesPanel from '../components/crm/QuotesPanel.jsx';
import InvoicesPanel from '../components/crm/InvoicesPanel.jsx';
import SalesPerformance from '../components/crm/SalesPerformance.jsx';
import MobileNav from '../components/MobileNav.jsx';
import QuickAddCommand from '../components/crm/QuickAddCommand.jsx';
import { OfflineBanner } from '../components/crm/ui.jsx';
import OnboardingPack from '../components/OnboardingPack.jsx';
import OnboardingPackCard from '../components/crm/OnboardingPackCard.jsx';
import { TABLES } from './stub.js';
// The server's own secure rules, so the fake function below keeps, refuses and
// names things exactly as the real one does.
import {
  heldFrom, ID_CARD_KEYS, idFileFits, isSecureFileKey, isSecureValueKey, MAX_SECURE_BYTES, SECURE_MIME, secureFileName,
  secureFileValid, securePath, secureVisible, serverValid, TERMS_VERSION, validPackKey,
} from '../../supabase/functions/_shared/onboardingSecure.ts';

// Harness only: the onboarding-form edge function, in memory, for #pack and
// #pack-us. Same actions and response shapes as
// supabase/functions/onboarding-form/index.ts: load, save (plain answers merge
// field by field, secure answers go to their own box and only _held comes
// back), upload-url (a fake signed URL, answered below with a 200) and submit.
// The packs live on window, so a hash change or a remount keeps what was typed;
// reload the page to start again. window.__packReject = ['bank.account_number']
// makes the next saves refuse that key, and window.__packFail = 503 fails
// every save, to see the page's error states.
const PACK_VENUES = {
  'harness-pack-uk': { region: 'UK', venue: 'Verde Macclesfield', venue_address: '14 Mill Street, Macclesfield, SK11 6NN', sent_to: 'dan@verde.example' },
  'harness-pack-us': { region: 'US', venue: 'Mozz Provo', venue_address: '120 N University Ave, Provo, UT 84601', sent_to: 'tony@mozz.example' },
};
const PACK_UPLOAD = `${window.location.origin}/__harness_upload/`;
window.__packStore = window.__packStore || {};
const packFor = (token) => {
  if (!window.__packStore[token]) {
    window.__packStore[token] = { rid: crypto.randomUUID(), answers: {}, meta: null, secure: {}, files: {}, submitted_at: null, updated_at: new Date().toISOString() };
  }
  return window.__packStore[token];
};
const packStr = (v) => String(v ?? '').trim();
function packFunction(body) {
  const env = PACK_VENUES[body.token];
  if (!env) return [404, { error: 'This link is not valid. Please ask your account manager for a new one.' }];
  const p = packFor(body.token);
  const { region } = env;
  const held = () => heldFrom(p.secure, p.files);
  const submitted = [409, { error: 'This pack has already been submitted.' }];

  if (body.action === 'load') {
    if (p.submitted_at) {
      return [200, { v: 2, venue: env.venue, submitted: true, prefill_name: packStr(p.answers.company?.contact_name) || packStr(p.answers.signoff?.full_name) }];
    }
    const answers = { ...p.answers, _held: held(), ...(p.meta ? { _meta: p.meta } : {}) };
    return [200, { v: 2, venue: env.venue, venue_address: env.venue_address, region, sent_to: env.sent_to, answers, held: held(), submitted: false, updated_at: p.updated_at }];
  }

  if (body.action === 'save') {
    if (p.submitted_at) return submitted;
    if (window.__packFail) return [window.__packFail, { error: 'Your answers could not be saved just now. Please try again.' }];
    const rejected = [];
    const idType = () => packStr(p.answers.representative?.id_type);
    // Plain answers first, so a card face saved with a new ID type records it.
    const entries = Object.entries(body.patch || {});
    for (const [sk, fields] of entries) {
      if (!validPackKey(sk) || !fields || typeof fields !== 'object') return [400, { error: 'That question is not part of this pack.', field: sk }];
      for (const fk of Object.keys(fields)) {
        if (!validPackKey(fk)) return [400, { error: 'That question is not part of this pack.', field: `${sk}.${fk}` }];
      }
    }
    for (const [sk, fields] of entries) {
      for (const [fk, v] of Object.entries(fields)) {
        const key = `${sk}.${fk}`;
        if (isSecureValueKey(key) || isSecureFileKey(key)) continue;
        const section = { ...(p.answers[sk] || {}) };
        let next = v;
        // A several file question sends {add, remove}: merged by path.
        if (v && typeof v === 'object' && !Array.isArray(v) && !('path' in v) && (Array.isArray(v.add) || Array.isArray(v.remove))) {
          const gone = new Set(v.remove || []);
          const seen = new Set();
          next = [...(Array.isArray(section[fk]) ? section[fk] : []), ...(v.add || [])]
            .filter((f) => f?.path && !gone.has(f.path) && !seen.has(f.path) && seen.add(f.path));
          if (!next.length) next = null;
        }
        if (next === null) delete section[fk]; else section[fk] = next;
        if (Object.keys(section).length) p.answers[sk] = section; else delete p.answers[sk];
      }
    }
    for (const [sk, fields] of entries) {
      for (const [fk, v] of Object.entries(fields)) {
        const key = `${sk}.${fk}`;
        if ((window.__packReject || []).includes(key)) { rejected.push(key); continue; }
        if (isSecureValueKey(key)) {
          if (v === null) delete p.secure[key];
          else if (typeof v === 'string' && serverValid(key, v.trim(), region)) p.secure[key] = v.trim();
          else rejected.push(key);
        } else if (isSecureFileKey(key)) {
          if (v === null) delete p.files[key];
          else if (secureFileValid(key, v, p.rid)) {
            p.files[key] = { path: v.path, name: secureFileName(key, v.mime), size: v.size, mime: v.mime };
            if (ID_CARD_KEYS.includes(key) && idType()) p.files[key].doc = idType();
          } else rejected.push(key);
        }
      }
    }
    p.updated_at = new Date().toISOString();
    p.meta = { ...(p.meta || {}), v: 2, region, saved_at: p.updated_at };
    return [200, { saved_at: p.updated_at, updated_at: p.updated_at, held: held(), rejected }];
  }

  if (body.action === 'upload-url') {
    if (p.submitted_at) return submitted;
    const key = `${body.sectionKey}.${body.fieldKey}`;
    if (isSecureFileKey(key)) {
      if (!SECURE_MIME.includes(String(body.mime || ''))) return [415, { error: 'Please choose a JPG, PNG or PDF file.' }];
      if (Number(body.size || 0) > MAX_SECURE_BYTES) return [413, { error: 'That file is larger than 10MB. Please choose a smaller one.' }];
      const path = securePath(p.rid, key, body.mime, crypto.randomUUID());
      return [200, { path, token: 'harness', signedUrl: PACK_UPLOAD + path, name: secureFileName(key, body.mime), mime: body.mime, secure: true }];
    }
    if (isSecureValueKey(key)) return [400, { error: 'That question does not take a file.' }];
    const name = packStr(body.fileName) || 'file';
    const path = `onboarding/${p.rid}/${crypto.randomUUID()}-${name.replace(/[^\w.-]+/g, '_')}`;
    return [200, { path, token: 'harness', signedUrl: PACK_UPLOAD + path, name }];
  }

  if (body.action === 'submit') {
    if (p.submitted_at) return submitted;
    // As the function does once the pack is in: anything secure the final
    // answers no longer ask for is deleted.
    const visible = secureVisible(p.answers, region);
    for (const k of Object.keys(p.secure)) if (!visible.has(k)) delete p.secure[k];
    for (const k of Object.keys(p.files)) if (!visible.has(k) || !idFileFits(k, p.files[k], p.answers)) delete p.files[k];
    p.submitted_at = new Date().toISOString();
    p.meta = { ...(p.meta || {}), v: 2, region, terms_version: TERMS_VERSION };
    return [200, { ok: true, files: Array.isArray(body.files) ? body.files.length : 0 }];
  }
  return [400, { error: 'Unknown action' }];
}

// The next few weekday call slots, so the booking invite looks as it does live.
const harnessSlots = () => {
  const out = [];
  const d = new Date();
  d.setMinutes(0, 0, 0);
  while (out.length < 4) {
    d.setHours(d.getHours() + 5);
    const h = d.getHours();
    if (d.getDay() !== 0 && d.getDay() !== 6 && h >= 9 && h <= 16) out.push(d.toISOString());
  }
  return out;
};

// Harness only: answer edge-function calls with canned Gmail data (and the
// onboarding pack function above) and record what each screen sent, so Reply
// and Reply all, and the pack's saves, can be checked without a server.
if (!window.__fnPatched) {
  window.__fnPatched = true; window.__fnCalls = [];
  const realFetch = window.fetch.bind(window);
  const ok = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const LIST = [
    { id: 'm1', threadId: 'th-1', from: 'Dan Marsh <dan@verde.example>', to: 'peter@posup.co.uk', subject: 'Menu changes for the weekend', date: iso(6), snippet: 'Can we add the brunch specials?', unread: false },
    { id: 'm2', threadId: 'th-1', from: 'Kate Lowe <kate@verde.example>', to: 'Peter <peter@posup.co.uk>, Dan Marsh <dan@verde.example>', subject: 'Re: Menu changes for the weekend', date: iso(1), snippet: 'Adding ops so they can update the kiosk.', unread: true },
    { id: 'm3', threadId: 'th-2', from: 'Adyen <no-reply@adyen.com>', to: 'peter@posup.co.uk', subject: 'Payout completed', date: iso(3), snippet: 'Your payout has been sent.', unread: false },
  ];
  const THREAD = [
    { id: 'm1', threadId: 'th-1', messageId: '<m1@verde.example>', from: 'Dan Marsh <dan@verde.example>', to: 'peter@posup.co.uk', cc: '', replyTo: '', references: '', subject: 'Menu changes for the weekend', date: iso(6), unread: false, text: 'Can we add the brunch specials for Saturday and Sunday?', html: '' },
    { id: 'm2', threadId: 'th-1', messageId: '<m2@verde.example>', from: 'Kate Lowe <kate@verde.example>', to: 'Peter <peter@posup.co.uk>, Dan Marsh <dan@verde.example>', cc: 'ops@verde.example, PETER@posup.co.uk', replyTo: '', references: '<m1@verde.example>', subject: 'Re: Menu changes for the weekend', date: iso(1), unread: true, text: 'Adding ops so they can update the kiosk menu too.', html: '' },
  ];
  window.fetch = (url, opts = {}) => {
    const u = String(url);
    // The PUT of a file to a signed upload URL from the fake onboarding-form.
    // The file itself is not kept: the page shows its own copy.
    if (u.startsWith(PACK_UPLOAD)) {
      window.__fnCalls.push({ fn: 'upload', path: u.slice(PACK_UPLOAD.length), method: opts.method, contentType: opts.headers?.['Content-Type'] });
      return Promise.resolve(new Response('', { status: 200 }));
    }
    if (!u.includes('/functions/v1/')) return realFetch(url, opts);
    const fn = u.split('/functions/v1/')[1].split('?')[0];
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not json */ }
    window.__fnCalls.push({ fn, body, contentType: opts.headers?.['Content-Type'], keepalive: !!opts.keepalive });
    if (fn === 'onboarding-form') {
      const [status, out] = packFunction(body);
      return Promise.resolve(new Response(JSON.stringify(out), { status, headers: { 'Content-Type': 'application/json' } }));
    }
    if (fn === 'booking-public') return ok(body.action === 'slots' ? { slots: harnessSlots() } : { durationMins: 30 });
    if (fn === 'gmail-personal') {
      if (body.action === 'list') return ok({ messages: LIST });
      if (body.action === 'thread') return ok({ messages: THREAD, subject: 'Re: Menu changes for the weekend' });
      if (body.action === 'send') return ok({ success: true, id: 'sent-1', threadId: body.threadId || 'th-1' });
      return ok({ success: true });
    }
    if (fn === 'gmail-send') {
      if (body.action === 'recipients') return ok({ from: 'Dan Marsh <dan@verde.example>', to: 'ops@verde.example', cc: 'kate@verde.example', reply_to: null });
      return ok({ success: true });
    }
    return ok({});
  };
}

const P = { id: 'u-peter', display_name: 'Peter', email: 'peter@posup.co.uk', role: 'owner' };

// The customer's page, full screen and outside the CRM layout, as it is live.
const PACK_ROUTES = { pack: 'harness-pack-uk', 'pack-us': 'harness-pack-us' };

// Our side of the same pack: the card on the o2 onboarding, whose submitted
// request and secure row are seeded in stub.js. #packcard-editor shows what an
// editor sees (Held securely, no Show, View or Delete). The switcher moves the
// SAME card instance to the o3 onboarding, the way Shell reuses it.
function PackCardView({ role }) {
  const [onbId, setOnbId] = useState('o2');
  const onboarding = TABLES.onboardings.find((o) => o.id === onbId);
  const venues = TABLES.locations.filter((l) => l.company_id === onboarding.company_id);
  const profile = role === 'editor' ? TABLES.profiles.find((m) => m.role === 'editor') : P;
  return (
    <div className="work" style={{ minHeight: '100vh', background: 'var(--scene-bg)', padding: 16 }}>
      <div style={{ maxWidth: 420, margin: '0 auto' }}>
        <div data-harness-switch style={{ display: 'flex', gap: 8, marginBottom: 8, fontSize: 12 }}>
          {['o2', 'o3'].map((id) => (
            <button key={id} type="button" onClick={() => setOnbId(id)} style={{ fontWeight: id === onbId ? 700 : 400 }}>
              {TABLES.onboardings.find((o) => o.id === id).name}
            </button>
          ))}
        </div>
        <OnboardingPackCard onboarding={onboarding} company={TABLES.companies.find((c) => c.id === onboarding.company_id)}
          location={venues.find((l) => l.id === onboarding.location_id)} locations={venues} contacts={TABLES.contacts}
          profile={profile} onChanged={() => {}} />
      </div>
    </div>
  );
}

function App() {
  const [v, setV] = useState(() => (location.hash || '#today').slice(1));
  useEffect(() => { const f = () => setV(location.hash.slice(1) || 'today'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const nav = () => {};
  if (PACK_ROUTES[v]) return <OnboardingPack key={v} token={PACK_ROUTES[v]} />;
  if (v === 'packcard' || v === 'packcard-editor') return <PackCardView key={v} role={v === 'packcard' ? 'owner' : 'editor'} />;
  return (
    <div className="work" style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--scene-bg)' }}>
      <main className="work flex-1 min-w-0 overflow-hidden lg:flex lg:flex-col">
        {v !== 'inbox' && <OfflineBanner onView={() => { location.hash = 'inbox'; }} />}
        <div className="contents lg:block lg:flex-1 lg:min-h-0">
        {v === 'today' && <TodayPanel profile={P} onNavigate={nav} />}
        {v === 'task' && <TaskDetail taskId="t3" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'ticket' && <TicketDetail ticketId="k1" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'project' && <ProjectDetail projectId="p1" profile={P} onClose={nav} onSelectTask={nav} onNavigate={nav} />}
        {v === 'projects' && <ProjectList profile={P} onSelect={nav} onNavigate={nav} />}
        {v === 'tasks' && <TaskList profile={P} onNavigate={nav} />}
        {v === 'timeline' && <Timeline profile={P} onNavigate={nav} />}
        {v === 'calendar' && <WorkCalendar profile={P} onNavigate={nav} />}
        {v === 'board' && <WorkBoard profile={P} onNavigate={nav} initialTab="board" />}
        {v === 'bills' && <BillsPanel profile={P} onNavigate={nav} />}
        {v === 'quote' && <QuoteBuilder quoteId="q1" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'reporting' && <ReportingDashboard profile={P} onNavigate={nav} />}
        {v === 'expenses' && <ExpensesPanel profile={P} onNavigate={nav} />}
        {v === 'owe' && <WhatIOwePanel profile={P} onNavigate={nav} />}
        {v === 'products' && <ProductsPanel profile={P} onNavigate={nav} />}
        {v === 'quotes' && <QuotesPanel profile={P} onNavigate={nav} onOpen={nav} />}
        {v === 'invoices' && <InvoicesPanel profile={P} onNavigate={nav} />}
        {v === 'sales' && <SalesPerformance profile={P} onNavigate={nav} />}
        {v === 'processing' && <PaymentsPanel profile={P} onNavigate={nav} />}
        {v === 'deal' && <DealDetail dealId="d1" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'lead' && <LeadDetail leadId="lead1" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'calls' && <CallLogPanel profile={P} onNavigate={nav} />}
        {v === 'inbox' && <MobileInbox profile={P} onNavigate={nav} />}
        {v === 'site' && <LocationDetail locationId="l1" profile={P} onClose={nav} onNavigate={nav} onCreateLead={nav} />}
        </div>
      </main>
      <MobileNav profile={P} view={v === 'project' ? 'projects' : v === 'site' ? 'locations' : v} onGo={(k) => { location.hash = k === 'locations' ? 'site' : k; }} />
      <QuickAddCommand profile={P} onNavigate={nav} />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
