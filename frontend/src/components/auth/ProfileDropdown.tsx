import { useEffect, useRef } from 'react';
import { LogOut, User, Mail, Shield, ChevronRight } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

interface ProfileDropdownProps {
  onClose: () => void;
  onOpenProfile: () => void;
}

export function ProfileDropdown({ onClose, onOpenProfile }: ProfileDropdownProps) {
  const { user, signOut } = useAuth();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleSignOut = async () => {
    onClose();
    await signOut();
  };

  const initials = user?.displayName
    ? user.displayName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : user?.email?.[0]?.toUpperCase() ?? 'U';

  const menuItem = (icon: React.ReactNode, label: string, onClick?: () => void, danger = false) => (
    <button
      key={label} onClick={onClick}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: '0.65rem',
        padding: '0.6rem 0.85rem', background: 'none', border: 'none',
        borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
        color: danger ? '#9a5040' : 'var(--text-secondary)',
        fontSize: '0.8rem', fontWeight: 500, transition: 'background 0.15s',
      }}
      onMouseEnter={e => (e.currentTarget.style.background = danger ? 'rgba(176,96,79,0.08)' : 'rgba(60,52,44,0.06)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'none')}
    >
      {icon}
      <span style={{ flex: 1 }}>{label}</span>
      {!danger && <ChevronRight size={12} color="rgba(60,52,44,0.24)" />}
    </button>
  );

  return (
    <div ref={ref} style={{
      position: 'absolute', top: 'calc(100% + 8px)', right: 0,
      width: '260px', zIndex: 500,
      background: 'rgba(255,255,255,0.97)', border: '1px solid rgba(60,52,44,0.12)',
      borderRadius: '14px', boxShadow: '0 16px 48px rgba(60,52,44,0.21)',
      backdropFilter: 'blur(24px)', overflow: 'hidden',
    }}>
      {/* User info header */}
      <div style={{ padding: '1rem', borderBottom: '1px solid rgba(60,52,44,0.084)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {user?.photoURL ? (
            <img src={user.photoURL} alt="avatar" style={{ width: '40px', height: '40px', borderRadius: '50%', objectFit: 'cover' }} />
          ) : (
            <div style={{
              width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0,
              background: '#5d6b80',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.85rem', fontWeight: 800, color: '#fff',
            }}>
              {initials}
            </div>
          )}
          <div style={{ overflow: 'hidden' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#2b2926', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.displayName ?? 'User'}
            </div>
            <div style={{ fontSize: '0.68rem', color: 'rgba(60,52,44,0.4)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user?.email}
            </div>
          </div>
        </div>
        {/* Pro badge */}
        <div style={{ marginTop: '0.65rem', display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'rgba(110,104,144,0.1)', border: '1px solid rgba(110,104,144,0.25)', borderRadius: '20px', padding: '0.2rem 0.65rem', width: 'fit-content' }}>
          <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: '#5c7d59' }} />
          <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#5f5a80', letterSpacing: '0.06em' }}>FREE PLAN</span>
        </div>
      </div>

      {/* Menu */}
      <div style={{ padding: '0.5rem' }}>
        {menuItem(<User size={14} />, 'Your Profile', onOpenProfile)}
        {menuItem(<Mail size={14} />, 'Notifications')}
        {menuItem(<Shield size={14} />, 'Account Security')}
      </div>

      <div style={{ borderTop: '1px solid rgba(60,52,44,0.084)', padding: '0.5rem' }}>
        {menuItem(<LogOut size={14} />, 'Sign Out', handleSignOut, true)}
      </div>
    </div>
  );
}
