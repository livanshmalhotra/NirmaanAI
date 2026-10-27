import { createContext, useContext, useState, useCallback } from 'react';

export interface AppNotification {
  id: string;
  iconName: 'Activity' | 'Thermometer' | 'Wind' | 'Zap' | 'Database' | 'CheckCircle' | 'AlertCircle' | 'Info';
  iconColor: string;
  title: string;
  body: string;
  time: number; // timestamp ms
  read: boolean;
}

interface NotificationsContextType {
  notifications: AppNotification[];
  unreadCount: number;
  addNotification: (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

const SEED: AppNotification[] = [
  { id: '1', iconName: 'Activity', iconColor: '#b0604f', title: 'Seismic Analysis Complete', body: 'IS 1893-2016 compliance check passed for Bengaluru Urban — Zone II, Low risk.', time: Date.now() - 2 * 60 * 1000, read: false },
  { id: '2', iconName: 'Thermometer', iconColor: '#a57c3a', title: 'Thermal Model Ready', body: 'EnergyPlus thermal simulation finished. Cooling load: 980 kWh/100 sqm.', time: Date.now() - 15 * 60 * 1000, read: false },
  { id: '3', iconName: 'Wind', iconColor: '#4f7d78', title: 'Wind Load Study', body: 'IS 875 Part-3 CFD analysis complete. Structural wind index: 3.1/10.', time: Date.now() - 60 * 60 * 1000, read: true },
  { id: '4', iconName: 'Database', iconColor: '#5f5a80', title: 'Karnataka DB Updated', body: '15 district records refreshed with Q2 2026 grid reliability data.', time: Date.now() - 3 * 60 * 60 * 1000, read: true },
  { id: '5', iconName: 'Zap', iconColor: '#5c7d59', title: 'Electrical Load Flow', body: 'IEEE 37-bus simulation complete. Grid reliability 97.2%, tariff ₹7.8/kWh.', time: Date.now() - 24 * 60 * 60 * 1000, read: true },
  { id: '6', iconName: 'CheckCircle', iconColor: '#5c7d59', title: 'Project Configured', body: 'Building project set up with ₹50L budget, Bengaluru Urban district.', time: Date.now() - 26 * 60 * 60 * 1000, read: true },
];

function load(): AppNotification[] {
  try {
    const raw = localStorage.getItem('archimind-notifications');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return SEED;
}

function save(ns: AppNotification[]) {
  try { localStorage.setItem('archimind-notifications', JSON.stringify(ns)); } catch { /* ignore */ }
}

const NotificationsContext = createContext<NotificationsContextType | null>(null);

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>(load);

  const update = useCallback((ns: AppNotification[]) => {
    setNotifications(ns);
    save(ns);
  }, []);

  const addNotification = useCallback((n: Omit<AppNotification, 'id' | 'time' | 'read'>) => {
    setNotifications(prev => {
      const next = [{ ...n, id: crypto.randomUUID(), time: Date.now(), read: false }, ...prev];
      save(next);
      return next;
    });
  }, []);

  const markAsRead = useCallback((id: string) => {
    setNotifications(prev => {
      const next = prev.map(n => n.id === id ? { ...n, read: true } : n);
      save(next);
      return next;
    });
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => {
      const next = prev.map(n => ({ ...n, read: true }));
      save(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setNotifications(prev => {
      const next = prev.filter(n => n.id !== id);
      save(next);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => update([]), [update]);

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <NotificationsContext.Provider value={{ notifications, unreadCount, addNotification, markAsRead, markAllAsRead, remove, clearAll }}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be inside NotificationsProvider');
  return ctx;
}
