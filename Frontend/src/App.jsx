import { useState } from 'react';
import { Plug, DownloadCloud, LayoutGrid, Waypoints, GitCompareArrows, ListChecks, CalendarClock, History, Workflow, BarChart3, PanelLeftClose, PanelLeft, ArrowLeft } from 'lucide-react';
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
import DashboardPage from './pages/DashboardPage';
import mastekLogo from './images/logo.png'
const NAV_PAGES = [
  { id: 'dashboard', label: 'Data Quality Dashboard', icon: BarChart3 },
  { id: 'connect', label: 'Connect', icon: Plug },
  // Sits between Connect and Harvest to match the data flow: connect, load the
  // data with a pipeline, then harvest what it produced.
  
  { id: 'harvest', label: 'Harvest MetaData', icon: DownloadCloud },
  { id: 'catalog', label: 'Catalog Viewer', icon: LayoutGrid },
  { id: 'pipelines', label: 'Test Data Preparation', icon: Workflow },
  { id: 'mapping', label: 'Test Layer & Test Suite Setup', icon: Waypoints },
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
  // Where a jump into the test-case editor came from, so the tester can get
  // back to the run they were reading rather than re-finding it in History.
  const [s2dReturn, setS2dReturn] = useState(null);
  // Collapsed to icons rather than hidden: the labels are long ("Test Layer &
  // Test Suite Setup"), so on a laptop the sidebar was eating a fifth of the
  // width that tables and charts need. Remembered across reloads because it's
  // a workspace preference, not a per-visit choice.
  const [navCollapsed, setNavCollapsed] = useState(
    () => localStorage.getItem('navCollapsed') === '1',
  );

  const toggleNav = () => setNavCollapsed((v) => {
    localStorage.setItem('navCollapsed', v ? '0' : '1');
    return !v;
  });

  const goToPage = (id) => {
    setActiveRunId(null);
    setS2dFocus(null);
    setS2dReturn(null);
    setActivePage(id);
  };

  const goToS2DWithFocus = (focus, returnTo = null) => {
    setActiveRunId(null);
    setS2dFocus(focus);
    setS2dReturn(returnTo);
    setActivePage('s2d');
  };

  // Back to the run whose result sent us here.
  const returnFromS2D = () => {
    const target = s2dReturn;
    setS2dFocus(null);
    setS2dReturn(null);
    setActiveRunId(target?.runId || null);
    setActivePage(target?.page || 's2d');
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
        onEditTestCase={(mappingId, testCaseId) => goToS2DWithFocus(
          { mappingId, testCaseId },
          { page: 'analytics', runId: activeRunId },
        )}
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
  } else if (activePage === 'dashboard') {
    content = <DashboardPage />;
  } else {
    content = (
      <>
        {/* Only when we arrived from a specific run - a Back button with
            nowhere to go is worse than none. */}
        {s2dReturn && (
          <button
            onClick={returnFromS2D}
            className="mb-4 flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-mastek-primary border border-mastek-primary/40 rounded-lg hover:bg-mastek-primary/10"
          >
            <ArrowLeft className="w-4 h-4" /> Back to results
          </button>
        )}
        <S2DPage
          onNavigateToRun={handleRunComplete}
          focus={s2dFocus}
        />
      </>
    );
  }

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
      {/* Width is an inline style, not a swapped w-16/w-60 class: Tailwind's dev
          server only emits the utility that was in use when the page loaded, so
          toggling left the rail at its old width until a hard refresh - labels
          vanishing while the sidebar stayed wide. An inline value always
          applies and can't depend on what the JIT happened to generate. */}
      <aside
        style={{ width: navCollapsed ? '4rem' : '15rem' }}
        className="bg-white border-r border-slate-200 flex flex-col shrink-0 transition-[width] duration-200 overflow-hidden"
      >
        <div className={`flex items-center h-16 border-b border-slate-200 shrink-0 ${
          navCollapsed ? 'justify-center px-2' : 'px-6'
        }`}>
          <img
            src={mastekLogo}
            alt="Mastek Logo"
            className={`object-contain ${navCollapsed ? 'w-9 h-9' : 'w-auto h-12'}`}
          />
        </div>

        <nav className="p-3 space-y-1">
          {NAV_PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => goToPage(id)}
              // The label disappears when collapsed, so it moves to the tooltip
              // - an icon-only rail with no way to identify the icons is worse
              // than the width it saves.
              title={navCollapsed ? label : undefined}
              className={`w-full flex items-center gap-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                navCollapsed ? 'justify-center px-0' : 'px-4'
              } ${
                activePage === id
                  ? 'bg-mastek-primary/10 text-mastek-primary'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {!navCollapsed && <span className="truncate">{label}</span>}
            </button>
          ))}
        </nav>

        <button
          onClick={toggleNav}
          title={navCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!navCollapsed}
          className={`mt-auto m-3 flex items-center gap-2 py-2 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-50 ${
            navCollapsed ? 'justify-center px-0' : 'px-4'
          }`}
        >
          {navCollapsed
            ? <PanelLeft className="w-4 h-4 shrink-0" />
            : <><PanelLeftClose className="w-4 h-4 shrink-0" /> Collapse</>}
        </button>
      </aside>

      <main className="flex-1 overflow-y-auto p-6 sm:p-8">
        {content}
      </main>
    </div>
  );
}

export default App;