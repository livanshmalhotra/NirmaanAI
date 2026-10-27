import { ShieldAlert, ShieldCheck, Shield } from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';

function riskColor(risk: number): string {
  if (risk >= 0.5) return '#b0604f';
  if (risk >= 0.25) return '#a57c3a';
  return '#5c7d59';
}

function riskLabel(risk: number): string {
  if (risk >= 0.5) return 'HIGH';
  if (risk >= 0.25) return 'MODERATE';
  return 'LOW';
}

/**
 * Always-on badge for the ML structural-risk score, pinned to the top-right
 * corner of the visualizer canvas (the open area beside the building). Reads
 * from context, so it reflects updates regardless of which UI path triggered
 * them (chat, quick-command buttons, or "Add Floor"). Flashes briefly whenever
 * the score changes.
 */
export function RiskToast() {
  const { state } = useBuilding();
  const risk = state.structuralRisk;
  const color = risk === null ? '#8f897f' : riskColor(risk);
  const Icon = risk === null ? Shield : risk >= 0.25 ? ShieldAlert : ShieldCheck;
  const pct = risk === null ? 0 : Math.round(risk * 100);

  return (
    <div style={{
      position: 'absolute', top: '0.75rem', right: '1rem', zIndex: 20,
      display: 'flex', alignItems: 'center', gap: '0.65rem',
      background: 'rgba(255,255,255,0.97)', border: `1px solid ${color}50`,
      borderLeft: `3px solid ${color}`,
      borderRadius: '10px', padding: '0.6rem 0.9rem',
      boxShadow: '0 12px 32px rgba(60,52,44,0.175)',
      backdropFilter: 'blur(16px)',
      transition: 'border-color 0.4s ease',
      width: '230px',
    }}>
      {/* Keyed on the score so the flash replays whenever it changes */}
      {risk !== null && (
        <div key={risk} style={{
          position: 'absolute', inset: '-1px', borderRadius: '10px', pointerEvents: 'none',
          boxShadow: `0 0 0 3px ${color}`, animation: 'riskFlash 1.2s ease-out forwards',
        }} />
      )}
      <style>{`@keyframes riskFlash { from { opacity: 0.6; } to { opacity: 0; } }`}</style>
      <Icon size={16} color={color} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2b2926', whiteSpace: 'nowrap' }}>
            ML Structural Risk
          </span>
          <span style={{ fontSize: '0.8rem', fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>
            {risk === null ? '—' : `${pct}%`}
          </span>
        </div>
        <div style={{ height: '3px', background: 'rgba(60,52,44,0.096)', borderRadius: '2px', overflow: 'hidden', margin: '4px 0 3px' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '2px', transition: 'width 0.5s ease, background 0.4s ease' }} />
        </div>
        <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>
          {risk === null ? 'Awaiting first assessment' : `${riskLabel(risk)} · seismic, soil & wind`}
        </div>
      </div>
    </div>
  );
}
