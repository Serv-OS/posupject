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

// Harness only: answer edge-function calls with canned Gmail data and record
// what each composer sent, so Reply and Reply all can be checked without Gmail.
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
    if (!u.includes('/functions/v1/')) return realFetch(url, opts);
    const fn = u.split('/functions/v1/')[1].split('?')[0];
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch { /* not json */ }
    window.__fnCalls.push({ fn, body });
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
function App() {
  const [v, setV] = useState(() => (location.hash || '#today').slice(1));
  useEffect(() => { const f = () => setV(location.hash.slice(1) || 'today'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const nav = () => {};
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
