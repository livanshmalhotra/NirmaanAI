import { useEffect, useState } from 'react';
import { Settings, Bell, Search } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useNotifications } from '../../context/NotificationsContext';
import { ProfileDropdown } from '../auth/ProfileDropdown';
import { NotificationsPanel } from './NotificationsPanel';
import { SettingsPanel } from './SettingsPanel';
import { getModelInfo } from '../../services/api';

export type Page = 'home' | 'models' | 'datasets' | 'simulations';

interface TopNavProps {
  currentPage: Page;
  onNavigate: (page: Page) => void;
  onOpenProfile: () => void;
}

type Panel = 'profile' | 'notifications' | 'settings' | null;

export function TopNav({ currentPage, onNavigate, onOpenProfile }: TopNavProps) {
  const { user } = useAuth();
  const { unreadCount } = useNotifications();
  const [searchVal, setSearchVal] = useState('');
  const [openPanel, setOpenPanel] = useState<Panel>(null);
  const [modelLoaded, setModelLoaded] = useState<boolean | null>(null);

  useEffect(() => {
    getModelInfo()
      .then(info => setModelLoaded(info.cost_model.loaded && info.risk_model.loaded))
      .catch(() => setModelLoaded(false));
  }, []);

  const togglePanel = (p: Panel) => setOpenPanel(prev => (prev === p ? null : p));

  const navLinks: { label: string; page: Page }[] = [
    { label: 'Home', page: 'home' },
    { label: 'Pro', page: 'models' },
    { label: 'Datasets', page: 'datasets' },
    { label: 'Simulations', page: 'simulations' },
  ];

  const initials = user?.displayName
    ? user.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.[0]?.toUpperCase() ?? 'P';

  return (
    <header style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 2rem', background: 'var(--bg-primary)',
      borderBottom: '1px solid var(--border-subtle)',
      height: '60px', flexShrink: 0, zIndex: 100, position: 'relative',
    }}>
      {/* Logo */}
      <button onClick={() => onNavigate('home')} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', transform: 'none' }}>
        <span style={{ fontWeight: 800, fontSize: '1.15rem', letterSpacing: '0.04em', color: 'var(--text-primary)' }}>
          निर्माण <span style={{ color: '#4f7d78' }}>AI</span>
        </span>
      </button>

      {/* Model status badge */}
      {modelLoaded !== null && (
        <span
          title={modelLoaded ? 'Cost & structural-risk ML models loaded and serving' : 'ML models unavailable — using fallback formulas (run model/train_*.py)'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
            fontSize: '0.62rem', fontWeight: 700,
            color: modelLoaded ? '#5c7d59' : '#a57c3a',
            background: modelLoaded ? 'rgba(92,125,89,0.1)' : 'rgba(165,124,58,0.1)',
            border: `1px solid ${modelLoaded ? 'rgba(92,125,89,0.3)' : 'rgba(165,124,58,0.3)'}`,
            borderRadius: '20px', padding: '0.2rem 0.65rem', whiteSpace: 'nowrap',
          }}
        >
          <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: modelLoaded ? '#5c7d59' : '#a57c3a' }} />
          {modelLoaded ? 'Model Loaded' : 'Fallback Mode'}
        </span>
      )}

      {/* Nav */}
      <nav style={{ display: 'flex', gap: '0.25rem' }}>
        {navLinks.map(({ label, page }) => (
          <button key={page} onClick={() => onNavigate(page)} style={{
            background: currentPage === page ? 'rgba(110,104,144,0.15)' : 'none',
            border: currentPage === page ? '1px solid rgba(110,104,144,0.4)' : '1px solid transparent',
            color: currentPage === page ? '#5f5a80' : 'var(--text-secondary)',
            padding: '0.4rem 1rem', fontSize: '0.875rem', fontWeight: 500,
            borderRadius: '6px', cursor: 'pointer', transition: 'all 0.2s', transform: 'none',
          }}
            onMouseEnter={e => { if (currentPage !== page) { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; (e.currentTarget as HTMLButtonElement).style.background = 'var(--border-subtle)'; } }}
            onMouseLeave={e => { if (currentPage !== page) { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-secondary)'; (e.currentTarget as HTMLButtonElement).style.background = 'none'; } }}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* Right side */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        {/* Search */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.4rem 0.85rem', width: '220px' }}>
          <Search size={14} color="var(--text-tertiary)" />
          <input type="text" placeholder="Search architecture library..." value={searchVal} onChange={e => setSearchVal(e.target.value)}
            style={{ background: 'none', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '0.8rem', width: '100%', fontFamily: 'inherit' }} />
        </div>

        {/* Settings */}
        <button onClick={() => togglePanel('settings')} style={{
          background: openPanel === 'settings' ? 'rgba(110,104,144,0.15)' : 'var(--bg-secondary)',
          border: openPanel === 'settings' ? '1px solid rgba(110,104,144,0.4)' : '1px solid var(--border-subtle)',
          borderRadius: '8px', padding: '0.45rem', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'none',
          color: openPanel === 'settings' ? '#5f5a80' : 'var(--text-secondary)', transition: 'all 0.15s',
        }}>
          <Settings size={16} />
        </button>

        {/* Bell */}
        <button onClick={() => togglePanel('notifications')} style={{
          background: openPanel === 'notifications' ? 'rgba(176,96,79,0.1)' : 'var(--bg-secondary)',
          border: openPanel === 'notifications' ? '1px solid rgba(176,96,79,0.3)' : '1px solid var(--border-subtle)',
          borderRadius: '8px', padding: '0.45rem', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'none',
          color: openPanel === 'notifications' ? '#9a5040' : 'var(--text-secondary)',
          position: 'relative', transition: 'all 0.15s',
        }}>
          <Bell size={16} />
          {unreadCount > 0 && (
            <span style={{ position: 'absolute', top: '3px', right: '3px', minWidth: '14px', height: '14px', background: '#b0604f', borderRadius: '20px', border: '1px solid var(--bg-primary)', fontSize: '0.5rem', fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        {/* Avatar */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => togglePanel('profile')} style={{
            width: '32px', height: '32px', borderRadius: '50%',
            border: openPanel === 'profile' ? '2px solid #5f5a80' : '2px solid transparent',
            background: user?.photoURL ? 'transparent' : '#5d6b80',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.75rem', fontWeight: 700, color: '#fff',
            cursor: 'pointer', transition: 'border-color 0.15s', overflow: 'hidden', padding: 0,
          }}>
            {user?.photoURL
              ? <img src={user.photoURL} alt="avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : initials}
          </button>

          {openPanel === 'profile' && (
            <ProfileDropdown
              onClose={() => setOpenPanel(null)}
              onOpenProfile={() => { setOpenPanel(null); onOpenProfile(); }}
            />
          )}
        </div>
      </div>

      {openPanel === 'notifications' && <NotificationsPanel onClose={() => setOpenPanel(null)} />}
      {openPanel === 'settings' && <SettingsPanel onClose={() => setOpenPanel(null)} />}
    </header>
  );
}
