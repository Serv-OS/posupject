import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import Sidebar from './Sidebar.jsx';
import PhoneBar from './PhoneBar.jsx';
import NotificationBell from './NotificationBell.jsx';
import TimerWidget from './TimerWidget.jsx';
import TimePanel from './crm/TimePanel.jsx';
import PaymentsPanel from './crm/PaymentsPanel.jsx';
import InvoicesPanel from './crm/InvoicesPanel.jsx';
import QuotesPanel from './crm/QuotesPanel.jsx';
import CallLogPanel from './crm/CallLogPanel.jsx';
import SalesPerformance from './crm/SalesPerformance.jsx';
import InvDashboard from './inventory/InvDashboard.jsx';
import StockView from './inventory/StockView.jsx';
import StockInView from './inventory/StockInView.jsx';
import StockOutView from './inventory/StockOutView.jsx';
import PurchasingView from './inventory/PurchasingView.jsx';
import StocktakeView from './inventory/StocktakeView.jsx';
import InvReportsView from './inventory/InvReportsView.jsx';
import InvoiceBuilder from './crm/InvoiceBuilder.jsx';
import BillsPanel from './finance/BillsPanel.jsx';
import BillBuilder from './finance/BillBuilder.jsx';
import WhatIOwePanel from './finance/WhatIOwePanel.jsx';
import CategoriesPanel from './finance/CategoriesPanel.jsx';
import RatesPanel from './finance/RatesPanel.jsx';
import ExpensesPanel from './finance/ExpensesPanel.jsx';
import ExpenseBuilder from './finance/ExpenseBuilder.jsx';
import VatReturnPanel from './finance/VatReturnPanel.jsx';
import BankFeedPanel from './finance/BankFeedPanel.jsx';
import ReportsPanel from './crm/ReportsPanel.jsx';
import ScheduleView from './staffing/ScheduleView.jsx';
import TimeOffView from './staffing/TimeOffView.jsx';
import StaffView from './staffing/StaffView.jsx';
import DepartmentsView from './staffing/DepartmentsView.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import AccountPanel from './AccountPanel.jsx';
import Board from './Board.jsx';
import UsersPanel from './UsersPanel.jsx';
import FeaturesPanel from './FeaturesPanel.jsx';
import ItemDetail from './ItemDetail.jsx';
import CompanyList from './crm/CompanyList.jsx';
import CompanyDetail from './crm/CompanyDetail.jsx';
import ContactList from './crm/ContactList.jsx';
import ContactDetail from './crm/ContactDetail.jsx';
import LocationList from './crm/LocationList.jsx';
import LocationDetail from './crm/LocationDetail.jsx';
import TaskList from './crm/TaskList.jsx';
import TaskDetail from './crm/TaskDetail.jsx';
import ProjectList from './crm/ProjectList.jsx';
import ProjectDetail from './crm/ProjectDetail.jsx';
import LeadBoard from './crm/LeadBoard.jsx';
import DealBoard from './crm/DealBoard.jsx';
import DealDetail from './crm/DealDetail.jsx';
import OnboardingBoard from './crm/OnboardingBoard.jsx';
import OnboardingDetail from './crm/OnboardingDetail.jsx';
import TicketList from './crm/TicketList.jsx';
import TicketDetail from './crm/TicketDetail.jsx';
import ModulesPanel from './crm/ModulesPanel.jsx';
import FeatureRequestList from './crm/FeatureRequestList.jsx';
import FeatureRequestDetail from './crm/FeatureRequestDetail.jsx';
import ReleaseList from './crm/ReleaseList.jsx';
import ReleaseDetail from './crm/ReleaseDetail.jsx';
import ReportingDashboard from './crm/ReportingDashboard.jsx';
import SettingsPanel from './crm/SettingsPanel.jsx';
import FormsList from './crm/FormsList.jsx';
import FormBuilder from './crm/FormBuilder.jsx';
import TemplatesPanel from './crm/TemplatesPanel.jsx';
import MyWork from './crm/MyWork.jsx';
import InboxPanel from './crm/InboxPanel.jsx';
import CalendarPanel from './crm/CalendarPanel.jsx';
import ChatPanel from './crm/ChatPanel.jsx';
import DataPanel from './crm/DataPanel.jsx';
import LeadDetail from './crm/LeadDetail.jsx';
import ProductsPanel from './crm/ProductsPanel.jsx';
import QuoteBuilder from './crm/QuoteBuilder.jsx';
import { Sun, Moon } from 'lucide-react';

export default function Shell({ session }) {
  const [profile, setProfile]   = useState(null);
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const [view, setView]         = useState('contacts');
  const [openItem, setOpenItem] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [leadPrefill, setLeadPrefill] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('servos-crm-theme') || 'light');

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('servos-crm-theme', theme);
  }, [theme]);

  // Start a lead from a record (company/location/contact detail "Create lead")
  const startLead = (prefill) => { setLeadPrefill(prefill); setView('leads'); };

  const refreshProfile = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('id', session.user.id).single();
    if (data) setProfile(data);
  };

  useEffect(() => {
    refreshProfile();
  }, [session.user.id]);

  useEffect(() => {
    load();
    const ch = supabase.channel('backlog_projects')
      .on('postgres_changes', { event:'*', schema:'public', table:'backlog_projects' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  const load = async () => {
    const { data } = await supabase.from('backlog_projects').select('*').eq('archived', false).order('created_at');
    setProjects(data || []);
    if (!activeProject && data?.length) setActiveProject(data[0]);
  };

  const signOut = async () => {
    try {
      await supabase.auth.signOut({ scope: 'global' });
    } catch {
      await supabase.auth.signOut({ scope: 'local' });
    }
  };

  // Navigate to a CRM record detail view
  const navigateTo = (type, id) => {
    if (type === 'company') { setView('company_detail'); setDetailId(id); }
    else if (type === 'contact') { setView('contact_detail'); setDetailId(id); }
    else if (type === 'location') { setView('location_detail'); setDetailId(id); }
    else if (type === 'deal') { setView('deal_detail'); setDetailId(id); }
    else if (type === 'onboarding') { setView('onboarding_detail'); setDetailId(id); }
    else if (type === 'ticket') { setView('ticket_detail'); setDetailId(id); }
    else if (type === 'project') { setView('project_detail'); setDetailId(id); }
    else if (type === 'task') { setView('task_detail'); setDetailId(id); }
    else if (type === 'lead') { if (id) { setView('lead_detail'); setDetailId(id); } else setView('leads'); }
    else if (type === 'quote') { setView('quote_detail'); setDetailId(id); }
    else if (type === 'processing') { setView('processing'); }
    else if (type === 'invoice') { setView('invoice_detail'); setDetailId(id); }
    else if (type === 'bill') { setView('bill_detail'); setDetailId(id); }
    else if (type === 'expense') { setView('expense_detail'); setDetailId(id); }
    else if (type === 'account') { setView('account'); }
    else if (type === 'inbox') { setView('inbox'); }
    else if (type === 'calendar') { setView('calendar'); }
    else if (type === 'chat') { setView('chat'); }
    // List shortcuts (used by My Work "View all")
    else if (type === 'ticket_list') { setView('tickets'); }
    else if (type === 'task_list') { setView('tasks'); }
    else if (type === 'deal_list') { setView('deals'); }
    else if (type === 'lead_list') { setView('leads'); }
  };

  if (!profile) return <div className="h-full flex items-center justify-center text-muted text-sm">Loading profile...</div>;

  const renderMain = () => {
    switch (view) {
      case 'mywork':
        return <MyWork profile={profile} onNavigate={navigateTo} />;
      case 'inbox':
        return <InboxPanel profile={profile} onNavigate={navigateTo} />;
      case 'calendar':
        return <CalendarPanel profile={profile} onNavigate={navigateTo} />;
      case 'chat':
        return <ChatPanel profile={profile} onNavigate={navigateTo} />;
      case 'users':
        return <UsersPanel profile={profile} />;
      case 'features':
        return activeProject ? <FeaturesPanel project={activeProject} profile={profile} /> : null;
      case 'companies':
        return <CompanyList profile={profile} onSelect={(id) => navigateTo('company', id)} />;
      case 'company_detail':
        return <CompanyDetail companyId={detailId} profile={profile}
          onClose={() => setView('companies')} onNavigate={navigateTo} onCreateLead={startLead} />;
      case 'contacts':
        return <ContactList profile={profile} onSelect={(id) => navigateTo('contact', id)} />;
      case 'contact_detail':
        return <ContactDetail contactId={detailId} profile={profile}
          onClose={() => setView('contacts')} onNavigate={navigateTo} onCreateLead={startLead} />;
      case 'locations':
        return <LocationList profile={profile} onSelect={(id) => navigateTo('location', id)} onNavigate={navigateTo} />;
      case 'location_detail':
        return <LocationDetail locationId={detailId} profile={profile}
          onClose={() => setView('locations')} onNavigate={navigateTo} onCreateLead={startLead} />;
      case 'leads':
        return <LeadBoard profile={profile} onNavigate={navigateTo} prefill={leadPrefill} onPrefillConsumed={() => setLeadPrefill(null)} />;
      case 'lead_detail':
        return <LeadDetail leadId={detailId} profile={profile} onClose={() => setView('leads')} onNavigate={navigateTo} />;
      case 'deals':
        return <DealBoard profile={profile} onSelectDeal={(id) => { setView('deal_detail'); setDetailId(id); }} onNavigate={navigateTo} />;
      case 'deal_detail':
        return <DealDetail dealId={detailId} profile={profile} onClose={() => setView('deals')} onNavigate={navigateTo} />;
      case 'onboarding':
        return <OnboardingBoard profile={profile} onSelectOnboarding={(id) => { setView('onboarding_detail'); setDetailId(id); }} onNavigate={navigateTo} />;
      case 'onboarding_detail':
        return <OnboardingDetail onboardingId={detailId} profile={profile} onClose={() => setView('onboarding')} onNavigate={navigateTo} />;
      case 'tickets':
        return <TicketList profile={profile} onSelect={(id) => { setView('ticket_detail'); setDetailId(id); }} onNavigate={navigateTo} />;
      case 'ticket_detail':
        return <TicketDetail ticketId={detailId} profile={profile} onClose={() => setView('tickets')} onNavigate={navigateTo} />;
      case 'modules':
        return <ModulesPanel profile={profile} />;
      case 'feature_requests':
        return <FeatureRequestList profile={profile} onSelect={(id) => { setView('feature_request_detail'); setDetailId(id); }} />;
      case 'feature_request_detail':
        return <FeatureRequestDetail requestId={detailId} profile={profile} onClose={() => setView('feature_requests')} onNavigate={navigateTo} />;
      case 'releases':
        return <ReleaseList profile={profile} onSelect={(id) => { setView('release_detail'); setDetailId(id); }} />;
      case 'release_detail':
        return <ReleaseDetail releaseId={detailId} profile={profile} onClose={() => setView('releases')} />;
      case 'reporting':
        return <ReportingDashboard profile={profile} />;
      case 'sales_performance':
        return <SalesPerformance profile={profile} onNavigate={navigateTo} />;
      case 'inv_dashboard':
        return <InvDashboard profile={profile} onNavigate={(t, id) => t === 'view' ? setView(id) : navigateTo(t, id)} />;
      case 'inv_stock':
        return <StockView profile={profile} onNavigate={navigateTo} />;
      case 'inv_in':
        return <StockInView profile={profile} />;
      case 'inv_out':
        return <StockOutView profile={profile} onNavigate={navigateTo} />;
      case 'inv_purchasing':
      case 'inv_orders':
        return <PurchasingView profile={profile} initialTab="orders" />;
      case 'inv_shipments':
        return <PurchasingView profile={profile} initialTab="transit" />;
      case 'inv_suppliers':
        return <PurchasingView profile={profile} initialTab="suppliers" />;
      case 'inv_stocktake':
        return <StocktakeView profile={profile} />;
      case 'inv_reports':
        return <InvReportsView />;
      case 'data':
        return <DataPanel profile={profile} />;
      case 'products':
        return <ProductsPanel profile={profile} />;
      case 'quote_detail':
        return <QuoteBuilder quoteId={detailId} profile={profile} onClose={() => setView('quotes')} onNavigate={navigateTo} />;
      case 'settings':
        return <SettingsPanel profile={profile} />;
      case 'account':
        return <AccountPanel profile={profile} onSaved={refreshProfile} />;
      case 'time':
        return <TimePanel profile={profile} onNavigate={navigateTo} />;
      case 'processing':
        return <PaymentsPanel profile={profile} onNavigate={navigateTo} />;
      case 'quotes':
        return <QuotesPanel profile={profile} onNavigate={navigateTo} />;
      case 'calls':
        return <CallLogPanel profile={profile} onNavigate={navigateTo} />;
      case 'invoices':
        return <InvoicesPanel profile={profile} onNavigate={navigateTo} />;
      case 'invoice_detail':
        return <InvoiceBuilder invoiceId={detailId} profile={profile} onClose={() => setView('invoices')} onNavigate={navigateTo} />;
      case 'bills':
        return <BillsPanel profile={profile} onNavigate={navigateTo} />;
      case 'bill_detail':
        return <BillBuilder billId={detailId} profile={profile} onClose={() => setView('bills')} onNavigate={navigateTo} />;
      case 'what_i_owe':
        return <WhatIOwePanel profile={profile} onNavigate={navigateTo} />;
      case 'finance_categories':
        return <CategoriesPanel profile={profile} />;
      case 'finance_rates':
        return <RatesPanel profile={profile} />;
      case 'expenses':
        return <ExpensesPanel profile={profile} onNavigate={navigateTo} />;
      case 'expense_detail':
        return <ExpenseBuilder expenseId={detailId} profile={profile} onClose={() => setView('expenses')} onNavigate={navigateTo} />;
      case 'finance_vat':
        return <VatReturnPanel profile={profile} />;
      case 'bank_feed':
        return <BankFeedPanel profile={profile} />;
      case 'finance_reports':
        return <ReportsPanel profile={profile} onNavigate={navigateTo} />;
      case 'schedule':
        return <ScheduleView profile={profile} />;
      case 'timeoff':
        return <TimeOffView profile={profile} />;
      case 'staff':
        return <StaffView profile={profile} onOpenUsers={() => setView('users')} />;
      case 'departments':
        return <DepartmentsView profile={profile} />;
      case 'templates':
        return <TemplatesPanel profile={profile} />;
      case 'forms':
        return <FormsList profile={profile} onSelect={(id) => { setView('form_detail'); setDetailId(id); }} />;
      case 'form_detail':
        return <FormBuilder formId={detailId} profile={profile} onClose={() => setView('forms')} onNavigate={navigateTo} />;
      case 'tasks':
        return <TaskList profile={profile} onSelect={(id) => { setView('task_detail'); setDetailId(id); }} />;
      case 'task_detail':
        return <TaskDetail taskId={detailId} profile={profile} onClose={() => setView('tasks')} onNavigate={navigateTo} />;
      case 'projects':
        return <ProjectList profile={profile} onSelect={(id) => { setView('project_detail'); setDetailId(id); }} />;
      case 'project_detail':
        return <ProjectDetail projectId={detailId} profile={profile}
          onClose={() => setView('projects')}
          onSelectTask={(id) => { setView('task_detail'); setDetailId(id); }}
          onNavigate={navigateTo} />;
      case 'board':
      default:
        return activeProject
          ? <Board project={activeProject} profile={profile} onOpenItem={setOpenItem} />
          : <div className="h-full flex items-center justify-center text-muted text-sm">No projects yet. Create one from the sidebar.</div>;
    }
  };

  // Wrap setView so picking a nav item closes the mobile drawer
  const setViewMobile = (v) => { setView(v); setSidebarOpen(false); };

  return (
    <div className="h-full flex">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/40 z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      {/* Sidebar: off-canvas drawer on mobile, static on desktop */}
      <div className={`fixed inset-y-0 left-0 z-40 flex shrink-0 transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar
          profile={profile}
          projects={projects}
          activeProject={activeProject}
          setActiveProject={(p) => { setActiveProject(p); setViewMobile('board'); }}
          view={view}
          setView={setViewMobile}
          onSignOut={signOut}
          onRefresh={load}
          theme={theme}
        />
      </div>
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      <div className="relative z-30 flex flex-wrap lg:flex-nowrap items-stretch border-b border-bdr">
        <button onClick={() => setSidebarOpen(true)}
          className="order-1 lg:hidden px-4 glass flex items-center text-paper text-xl shrink-0" title="Menu">{'☰'}</button>
        <div className="order-3 lg:order-1 w-full lg:w-auto lg:flex-1 min-w-0 border-t lg:border-t-0 border-bdr">
          <PhoneBar profile={profile} />
        </div>
        <div className="order-2 lg:order-2 flex-1 lg:flex-none flex items-center justify-end gap-2 px-3 glass">
          <TimerWidget profile={profile} onNavigate={navigateTo} />
          <GlobalSearch onNavigate={navigateTo} />
          <button onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-muted hover:text-paper hover:bg-card transition shrink-0"
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <NotificationBell profile={profile} onNavigate={navigateTo} />
        </div>
      </div>
      <main className="flex-1 min-w-0 overflow-hidden">
        {renderMain()}
      </main>
      </div>
      {openItem && (
        <ItemDetail
          itemId={openItem}
          profile={profile}
          onClose={() => setOpenItem(null)}
        />
      )}
    </div>
  );
}
