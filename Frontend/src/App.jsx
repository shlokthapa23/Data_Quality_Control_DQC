import { useState } from 'react';
import { Plug, DownloadCloud, LayoutGrid, GitCompareArrows, History } from 'lucide-react';
import ConnectPage from './components/ConnectPage';
import HarvestWizard from './components/HarvestWizard';
import CatalogPage from './components/CatalogPage';
import S2DPage from './components/S2DPage';
import AnalyticsPage from './components/AnalyticsPage';
import HistoryPage from './components/HistoryPage';
import mastekLogo from './images/logo.png'
const NAV_PAGES = [
  { id: 'connect', label: 'Connect', icon: Plug },
  { id: 'harvest', label: 'Harvest', icon: DownloadCloud },
  { id: 'catalog', label: 'Catalog', icon: LayoutGrid },
  { id: 's2d', label: 'S2D Validation', icon: GitCompareArrows },
  { id: 'history', label: 'History', icon: History },
];

function App() {
  const [activePage, setActivePage] = useState('harvest');
  const [activeRunId, setActiveRunId] = useState(null);
  const [analyticsReturnTo, setAnalyticsReturnTo] = useState('s2d'); // where "back" goes from Analytics

  const goToPage = (id) => {
    setActiveRunId(null);
    setActivePage(id);
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
  } else if (activePage === 'harvest') {
    content = <HarvestWizard />;
  } else if (activePage === 'catalog') {
    content = <CatalogPage />;
  } else if (activePage === 'history') {
    content = <HistoryPage onOpenRun={handleOpenRunFromHistory} />;
  } else {
    content = <S2DPage onNavigateToRun={handleRunComplete} />;
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