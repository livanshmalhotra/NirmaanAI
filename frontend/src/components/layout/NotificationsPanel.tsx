import { useEffect, useRef } from 'react';
import { X, Activity, Thermometer, Wind, Zap, Database, CheckCircle, AlertCircle, Info, Clock, Trash2 } from 'lucide-react';
import { useNotifications, type AppNotification } from '../../context/NotificationsContext';

const ICON_MAP: Record<AppNotification['iconName'], React.ReactNode> = {
  Activity:     <Activity size={14} />,
  Thermometer:  <Thermometer size={14} />,
  Wind:         <Wind size={14} />,
  Zap:          <Zap size={14} />,
  Database:     <Database size={14} />,
  CheckCircle:  <CheckCircle size={14} />,
  AlertCircle:  <AlertCircle size={14} />,
  Info:         <Info size={14} />,
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'Yesterday' : `${days} days ago`;
}

interface NotificationsPanelProps {
  onClose: () => void;
}

export function NotificationsPanel({ onClose }: NotificationsPanelProps) {
  const { notifications, unreadCount, markAsRead, markAllAsRead, remove, clearAll } = useNotifications();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} style={{
      position: 'fixed', top: '60px', right: '1rem', zIndex: 400,
      width: '340px', maxHeight: 'calc(100vh - 80px)',
      background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
      borderRadius: '16px', boxShadow: 'var(--glass-shadow)',
      backdropFilter: 'blur(24px)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '1rem 1.1rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text-primary)' }}>Notifications</span>
          {unreadCount > 0 && (
            <span style={{ background: '#b0604f', color: '#fff', fontSize: '0.58rem', fontWeight: 800, borderRadius: '20px', padding: '0.1rem 0.45rem', lineHeight: 1.6 }}>
              {unreadCount} new
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          {notifications.length > 0 && (
            <button onClick={clearAll} title="Clear all" style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
              color: 'var(--text-tertiary)', display: 'flex', borderRadius: '6px',
            }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(176,96,79,0.1)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <Trash2 size={14} />
            </button>
          )}
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', display: 'flex', padding: '4px', borderRadius: '6px' }}>
            <X size={15} />
          </button>
        </div>
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {notifications.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '3rem 1rem', color: 'var(--text-tertiary)' }}>
            <CheckCircle size={28} />
            <div style={{ fontSize: '0.8rem', fontWeight: 600 }}>All caught up</div>
            <div style={{ fontSize: '0.7rem' }}>No notifications</div>
          </div>
        ) : (
          notifications.map((n, i) => (
            <div
              key={n.id}
              onClick={() => markAsRead(n.id)}
              style={{
                padding: '0.85rem 1.1rem', cursor: 'pointer', transition: 'background 0.15s',
                borderBottom: i < notifications.length - 1 ? '1px solid var(--border-subtle)' : 'none',
                background: n.read ? 'transparent' : 'rgba(110,104,144,0.04)',
                display: 'flex', gap: '0.75rem', position: 'relative',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(60,52,44,0.048)')}
              onMouseLeave={e => (e.currentTarget.style.background = n.read ? 'transparent' : 'rgba(110,104,144,0.04)')}
            >
              {/* Icon */}
              <div style={{ width: '32px', height: '32px', borderRadius: '8px', flexShrink: 0, marginTop: '1px',
                background: `${n.iconColor}15`, border: `1px solid ${n.iconColor}25`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: n.iconColor }}>
                {ICON_MAP[n.iconName]}
              </div>

              {/* Content */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.4rem', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.3 }}>{n.title}</span>
                  {!n.read && <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#5f5a80', flexShrink: 0, marginTop: '3px' }} />}
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '0.3rem' }}>{n.body}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>
                  <Clock size={10} />{timeAgo(n.time)}
                </div>
              </div>

              {/* Remove button */}
              <button
                onClick={e => { e.stopPropagation(); remove(n.id); }}
                style={{ position: 'absolute', top: '0.75rem', right: '0.75rem', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)', padding: '2px', display: 'none', borderRadius: '4px' }}
                className="notif-remove"
              >
                <X size={12} />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {notifications.length > 0 && (
        <div style={{ padding: '0.75rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
          {unreadCount > 0 && (
            <button onClick={markAllAsRead} style={{ flex: 1, background: 'none', border: '1px solid var(--border-subtle)', borderRadius: '8px', color: '#5f5a80', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', padding: '0.45rem', fontFamily: 'inherit' }}>
              Mark all read
            </button>
          )}
          <button onClick={clearAll} style={{ flex: 1, background: 'rgba(176,96,79,0.08)', border: '1px solid rgba(176,96,79,0.2)', borderRadius: '8px', color: '#9a5040', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer', padding: '0.45rem', fontFamily: 'inherit' }}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
