import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import TodayPanel from '../components/crm/TodayPanel.jsx';
import TaskDetail from '../components/crm/TaskDetail.jsx';
import ProjectDetail from '../components/crm/ProjectDetail.jsx';
import WorkBoard from '../components/crm/WorkBoard.jsx';
import BillsPanel from '../components/finance/BillsPanel.jsx';
import QuoteBuilder from '../components/crm/QuoteBuilder.jsx';
import MobileInbox from '../components/crm/MobileInbox.jsx';
import LocationDetail from '../components/crm/LocationDetail.jsx';
import MobileNav from '../components/MobileNav.jsx';
import QuickAddCommand from '../components/crm/QuickAddCommand.jsx';
import { OfflineBanner } from '../components/crm/ui.jsx';
const P = { id: 'u-peter', display_name: 'Peter', email: 'peter@posup.co.uk', role: 'owner' };
function App() {
  const [v, setV] = useState(() => (location.hash || '#today').slice(1));
  useEffect(() => { const f = () => setV(location.hash.slice(1) || 'today'); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  const nav = () => {};
  return (
    <div className="work" style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--scene-bg)' }}>
      {v !== 'inbox' && <div className="fixed top-0 inset-x-0 z-50 pointer-events-none [&>*]:pointer-events-auto"><OfflineBanner onView={() => { location.hash = 'inbox'; }} /></div>}
      <main className="work" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
        {v === 'today' && <TodayPanel profile={P} onNavigate={nav} />}
        {v === 'task' && <TaskDetail taskId="t3" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'project' && <ProjectDetail projectId="p1" profile={P} onClose={nav} onSelectTask={nav} onNavigate={nav} />}
        {v === 'board' && <WorkBoard profile={P} onNavigate={nav} initialTab="board" />}
        {v === 'bills' && <BillsPanel profile={P} onNavigate={nav} />}
        {v === 'quote' && <QuoteBuilder quoteId="q1" profile={P} onClose={nav} onNavigate={nav} />}
        {v === 'inbox' && <MobileInbox profile={P} onNavigate={nav} />}
        {v === 'site' && <LocationDetail locationId="l1" profile={P} onClose={nav} onNavigate={nav} onCreateLead={nav} />}
      </main>
      <MobileNav profile={P} view={v === 'project' ? 'projects' : v === 'site' ? 'locations' : v} onGo={(k) => { location.hash = k === 'locations' ? 'site' : k; }} />
      <QuickAddCommand profile={P} onNavigate={nav} />
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
