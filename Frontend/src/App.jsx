import { useState } from 'react';
import { Plug, DownloadCloud, LayoutGrid, Waypoints, GitCompareArrows, ListChecks, CalendarClock, History, Workflow } from 'lucide-react';
import ConnectPage from './pages/ConnectPage';
import PipelinesPage from './pages/PipelinesPage';
import HarvestWizard from './pages/HarvestWizard';
import CatalogPage from './pages/CatalogPage';
import MappingsPage from './pages/MappingsPage';
import S2DPage from './pages/S2DPage';
import TestSuitesPage from './pages/TestSuitesPage';
import SchedulesDashboard from './pages/SchedulesDashboard';
import AnalyticsPage from './pages/AnalyticsPage';
import HistoryPage from './pages/HistoryPage';
import mastekLogo from './images/logo.png'
const NAV_PAGES = [
  { id: 'connect', label: 'Connect', icon: Plug },
  // Sits between Connect and Harvest to match the data flow: connect, load the
  // data with a pipeline, then harvest what it produced.
  
  { id: 'harvest', label: 'Harvest MetaData', icon: DownloadCloud },
  { id: 'catalog', label: 'Catalog Viewer', icon: LayoutGrid },
  { id: 'mapping', label: 'Test Layer & Test Suite Setup', icon: Waypoints },
  { id: 'pipelines', label: 'Test Data Preparation', icon: Workflow },
  { id: 's2d', label: 'Test Cases Validation', icon: GitCompareArrows },
  { id: 'suites', label: 'Test Suite Execution', icon: ListChecks },
  { id: 'schedules', label: 'Test Suite & Harvest Schedule', icon: CalendarClock },
  { id: 'history', label: 'Test Run History', icon: History },
];

function App() {
  const [activePage, setActivePage] = useState('harvest');
  const [activeRunId, setActiveRunId] = useState(null);
  const [analyticsReturnTo, setAnalyticsReturnTo] = useState('s2d'); // where "back" goes from Analytics
  // Cross-page handoff into Test Cases Validation: { mappingId, suiteId } to open
  // suite-membership editing pre-targeted at that suite, or
  // { mappingId, testCaseId } to open the edit form for that test case.
  // Set by Test Suite Execution's Edit Suite / row Edit buttons. Deliberately
  // NOT auto-cleared right after TestCasePanel consumes it - React 18
  // StrictMode's dev-only double-mount check (mount -> unmount -> remount,
  // to verify effects are safely re-runnable) would otherwise discard the
  // state the first "throwaway" mount just set, with nothing left for the
  // real second mount to pick up since the trigger was already cleared.
  // Instead it lives here in the stable parent until the user actually
  // navigates elsewhere via goToPage, so any StrictMode remount of the
  // S2D subtree still sees the same focus and re-applies it identically.
  const [s2dFocus, setS2dFocus] = useState(null);

  const goToPage = (id) => {
    setActiveRunId(null);
    setS2dFocus(null);
    setActivePage(id);
  };

  const goToS2DWithFocus = (focus) => {
    setActiveRunId(null);
    setS2dFocus(focus);
    setActivePage('s2d');
  };

  const handleRunComplete = (runId) => {
    setActiveRunId(runId);
    setAnalyticsReturnTo('s2d');
    setActivePage('analytics');
  };

  const handleOpenRunFromHistory = (runId) => {
    setActiveRunId(runId);
    setAnalyticsReturnTo('history');
    setActivePage('analytics');
  };

  const handleBackFromAnalytics = () => {
    setActiveRunId(null);
    setActivePage(analyticsReturnTo);
  };

  let content;
  if (activePage === 'analytics' && activeRunId) {
    content = (
      <AnalyticsPage
        runId={activeRunId}
        onBackToS2D={handleBackFromAnalytics}
        onGoToHistory={() => goToPage('history')}
      />
    );
  } else if (activePage === 'connect') {
    content = <ConnectPage />;
  } else if (activePage === 'pipelines') {
    content = <PipelinesPage onGoToHarvest={() => goToPage('harvest')} />;
  } else if (activePage === 'harvest') {
    content = <HarvestWizard />;
  } else if (activePage === 'catalog') {
    content = <CatalogPage />;
  } else if (activePage === 'mapping') {
    content = <MappingsPage />;
  } else if (activePage === 'history') {
    content = <HistoryPage onOpenRun={handleOpenRunFromHistory} />;
  } else if (activePage === 'suites') {
    content = (
      <TestSuitesPage
        onNavigateToRun={handleRunComplete}
        onEditSuite={(mappingId, suiteId) => goToS2DWithFocus({ mappingId, suiteId })}
        onEditTestCase={(mappingId, testCaseId) => goToS2DWithFocus({ mappingId, testCaseId })}
      />
    );
  } else if (activePage === 'schedules') {
    content = <SchedulesDashboard />;
  } else {
    content = (
      <S2DPage
        onNavigateToRun={handleRunComplete}
        focus={s2dFocus}
      />
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
      <aside className="w-60 bg-white border-r border-slate-200 flex flex-col shrink-0">
        <div className="flex items-center h-16 px-6 border-b border-slate-200 shrink-0">
          <img 
    src={mastekLogo} 
    alt="Mastek Logo" 
    className="w-auto h-12 object-contain" 
  />
        </div>
        <nav className="p-3 space-y-1">
          {NAV_PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => goToPage(id)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                activePage === id
                  ? 'bg-mastek-primary/10 text-mastek-primary'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 overflow-y-auto p-6 sm:p-8">
        {content}
      </main>
    </div>
  );
}

export default App;