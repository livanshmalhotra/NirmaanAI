import { useState } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { NotificationsProvider } from './context/NotificationsContext';
import { BuildingProvider } from './context/BuildingContext';
import { TopNav, type Page } from './components/layout/TopNav';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { LeftWorkspace } from './components/layout/LeftWorkspace';
import { DesignProvider } from './context/DesignContext';
import { PresetDialog } from './components/planner/PresetDialog';
import { BuildingVisualizer } from './components/visualizer/BuildingVisualizer';
import { StatsPanel } from './components/stats/StatsPanel';
import { ProPage } from './components/pages/ProPage';
import { DatasetsPage } from './components/pages/DatasetsPage';
import { SimulationsPage } from './components/pages/SimulationsPage';
import { ProfilePage } from './components/pages/ProfilePage';
import { ConfigurationModal } from './components/setup/ConfigurationModal';
import { LoginPage } from './components/auth/LoginPage';

export type AppPage = Page | 'profile';

function AppShell() {
  const { user, loading } = useAuth();
  const [currentPage, setCurrentPage] = useState<AppPage>('home');
  const [isConfigured, setIsConfigured] = useState(false);

  if (loading) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ fontSize: '1.2rem', fontWeight: 800, letterSpacing: '0.06em', color: 'var(--text-primary)' }}>
          निर्माण <span style={{ color: '#4f7d78' }}>AI</span>
        </div>
        <div style={{ width: '120px', height: '2px', background: 'var(--border-subtle)', borderRadius: '1px', overflow: 'hidden' }}>
          <div style={{ height: '100%', background: 'linear-gradient(90deg, #7d8aa3, #8fa9a2)', animation: 'slide 1.2s ease-in-out infinite', borderRadius: '1px' }} />
        </div>
        <style>{`@keyframes slide{0%{width:0%;margin-left:0}50%{width:80%;margin-left:10%}100%{width:0%;margin-left:100%}}`}</style>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  const navPage: Page = currentPage === 'profile' ? 'home' : currentPage as Page;

  return (
    <BuildingProvider>
      <div className="app-container">
        {!isConfigured && <ConfigurationModal onComplete={() => setIsConfigured(true)} />}
        <TopNav
          currentPage={navPage}
          onNavigate={p => setCurrentPage(p)}
          onOpenProfile={() => setCurrentPage('profile')}
        />
        <DesignProvider>
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          {/* Pro lays out its own tabs, each with the panels it needs */}
          {currentPage !== 'profile' && currentPage !== 'models' && <LeftSidebar />}

          {currentPage === 'home' && <><LeftWorkspace /><BuildingVisualizer /><StatsPanel /></>}
          {currentPage === 'models' && <ProPage />}
          {currentPage === 'datasets' && <DatasetsPage />}
          {currentPage === 'simulations' && <SimulationsPage />}
          {currentPage === 'profile' && <ProfilePage onBack={() => setCurrentPage('home')} />}
        </div>
        <PresetDialog />
        </DesignProvider>
      </div>
    </BuildingProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <NotificationsProvider>
        <AuthProvider>
          <AppShell />
        </AuthProvider>
      </NotificationsProvider>
    </ThemeProvider>
  );
}

export default App;
