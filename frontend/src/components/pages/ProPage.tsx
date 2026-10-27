import { useState } from 'react';
import { Crown, Check, ArrowLeft, Sparkles, LayoutGrid, Activity, CalendarClock } from 'lucide-react';
import { LeftSidebar } from '../layout/LeftSidebar';
import { LeftWorkspace } from '../layout/LeftWorkspace';
import { BuildingVisualizer } from '../visualizer/BuildingVisualizer';
import { StatsPanel } from '../stats/StatsPanel';
import { SimulationsPage } from './SimulationsPage';
import { DesignGenerator } from '../pro/DesignGenerator';
import { LifecyclePanel } from '../pro/LifecyclePanel';

export const PRO_PRICE_INR = 999;

const FREE_FEATURES = [
  'Design your home: floor plans, rooms, windows, walls, parking & garden',
  'AI chat assistant',
  'KPWD Schedule of Rates cost estimate',
  'IS 1893 seismic analysis with official hazard data',
];

const PRO_FEATURES = [
  'Everything in Free — same designer and simulations, in one workspace',
  'AI design generator: describe your home, get a complete, editable design',
  'Every generated design priced and checked against your budget and IS 1893',
  'Lifecycle & maintenance: CPWD schedules, KPWD repair rates, service lives',
  'Envelope check to Eco-Niwas Samhita 2018 (U-values, RETV) and rainwater',
  'What-if comparisons of walls, roof, finishes and glazing',
];

type Tab = 'design' | 'generate' | 'simulations' | 'lifecycle';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'design', label: 'Design', icon: <LayoutGrid size={14} /> },
  { id: 'generate', label: 'AI Generate', icon: <Sparkles size={14} /> },
  { id: 'simulations', label: 'Simulations', icon: <Activity size={14} /> },
  { id: 'lifecycle', label: 'Lifecycle', icon: <CalendarClock size={14} /> },
];

function Pricing({ onOpen }: { onOpen: () => void }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      <div style={{ padding: '1.5rem 2rem', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.12em', color: 'var(--text-tertiary)', marginBottom: '0.25rem' }}>निर्माण AI</div>
        <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>Upgrade to Pro</h2>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          Generate designs from a brief and see what they cost to build and to keep up
        </p>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '2rem', display: 'flex', justifyContent: 'center' }}>
        <div style={{ display: 'flex', gap: '1.25rem', width: '100%', maxWidth: '860px', alignItems: 'stretch' }}>
          <div style={{ flex: 1, background: 'rgba(60,52,44,0.024)', border: '1px solid var(--border-subtle)', borderRadius: '16px', padding: '1.75rem', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: '0.6rem', letterSpacing: '0.12em', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>CURRENT PLAN</div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.25rem' }}>Free</div>
            <div style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.25rem' }}>₹0</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>Forever free</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {FREE_FEATURES.map(f => (
                <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <Check size={13} color="#5c7d59" style={{ flexShrink: 0, marginTop: '1px' }} />{f}
                </div>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, background: 'rgba(93,107,128,0.045)', border: '1px solid rgba(110,104,144,0.4)', borderRadius: '16px', padding: '1.75rem', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <Crown size={14} color="#a57c3a" fill="#a57c3a" />
              <div style={{ fontSize: '0.6rem', letterSpacing: '0.12em', color: '#a57c3a', fontWeight: 700 }}>RECOMMENDED</div>
            </div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.25rem', color: '#5f5a80' }}>Pro</div>
            <div style={{ fontSize: '2rem', fontWeight: 800, marginBottom: '0.25rem' }}>₹{PRO_PRICE_INR.toLocaleString('en-IN')}</div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginBottom: '1.5rem' }}>per month</div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {PRO_FEATURES.map(f => (
                <div key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  <Check size={13} color="#5f5a80" style={{ flexShrink: 0, marginTop: '1px' }} />{f}
                </div>
              ))}
            </div>
            <button onClick={onOpen} style={{ marginTop: '1.5rem', padding: '0.75rem', background: '#5d6b80', border: 'none', borderRadius: '10px', color: '#fff', fontSize: '0.85rem', fontWeight: 700, cursor: 'pointer' }}>
              Open Pro workspace
            </button>
            <div style={{ textAlign: 'center', fontSize: '0.68rem', color: 'var(--text-tertiary)', marginTop: '0.5rem' }}>
              Payments aren't connected yet — Pro is open to try
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Pro: the Home designer and the Simulations page (the same components, on the
 * same building), plus the AI design generator and lifecycle analysis.
 */
export function ProPage() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('design');
  if (!open) return <Pricing onOpen={() => setOpen(true)} />;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.45rem 1rem', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-primary)' }}>
        <button onClick={() => setOpen(false)} title="Plans" style={{ background: 'rgba(60,52,44,0.048)', border: '1px solid var(--border-subtle)', borderRadius: '8px', padding: '0.3rem 0.55rem', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex' }}>
          <ArrowLeft size={13} />
        </button>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.68rem', fontWeight: 700, color: '#5f5a80' }}>
          <Crown size={12} color="#a57c3a" fill="#a57c3a" /> PRO
        </span>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.4rem 0.8rem', borderRadius: '8px', fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer',
              background: tab === t.id ? 'rgba(93,107,128,0.135)' : 'transparent',
              border: `1px solid ${tab === t.id ? 'rgba(110,104,144,0.6)' : 'transparent'}`,
              color: tab === t.id ? '#2b2926' : 'var(--text-secondary)',
            }}>{t.icon}{t.label}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {tab === 'design' && <><LeftSidebar /><LeftWorkspace /><BuildingVisualizer /><StatsPanel /></>}
        {tab === 'generate' && <DesignGenerator onApplied={() => setTab('design')} />}
        {tab === 'simulations' && <><LeftSidebar /><SimulationsPage /></>}
        {tab === 'lifecycle' && <LifecyclePanel />}
      </div>
    </div>
  );
}
