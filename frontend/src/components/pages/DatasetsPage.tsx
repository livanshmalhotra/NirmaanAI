import { Database, Wind, Zap, Thermometer, Activity } from 'lucide-react';
import { KARNATAKA_DISTRICTS } from '../../data/karnataka_db';

const REGION_COLORS: Record<string, string> = {
  'South Karnataka':        '#6e6890',
  'North Karnataka':        '#a57c3a',
  'Coastal Karnataka':      '#4f7d78',
  'Hyderabad Karnataka':    '#a8714a',
  'Malnad / Western Ghats': '#5c7d59',
};

const RISK_COLORS: Record<string, string> = {
  Low:      '#5c7d59',
  Moderate: '#a57c3a',
  High:     '#b0604f',
};

const ZONE_COLORS: Record<string, string> = {
  'II':  '#5c7d59',
  'III': '#a57c3a',
  'IV':  '#b0604f',
};

const CLIMATE_COLORS: Record<string, string> = {
  'Hot-Dry':   '#b0604f',
  'Hot-Humid': '#4f7d78',
  'Composite': '#6e6890',
  'Temperate': '#5c7d59',
};

function WindBar({ value }: { value: number }) {
  const pct = (value / 10) * 100;
  const color = value < 4 ? '#5c7d59' : value < 6 ? '#a57c3a' : '#b0604f';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div style={{ width: '60px', height: '4px', background: 'rgba(60,52,44,0.096)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: '2px' }} />
      </div>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{value.toFixed(1)}</span>
    </div>
  );
}

function GridBar({ value }: { value: number }) {
  const color = value >= 95 ? '#5c7d59' : value >= 90 ? '#a57c3a' : '#b0604f';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <div style={{ width: '60px', height: '4px', background: 'rgba(60,52,44,0.096)', borderRadius: '2px', overflow: 'hidden' }}>
        <div style={{ width: `${value}%`, height: '100%', background: color, borderRadius: '2px' }} />
      </div>
      <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>{value}%</span>
    </div>
  );
}

export function DatasetsPage() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div style={{
        padding: '1.5rem 2rem',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: '0.65rem', letterSpacing: '0.12em', color: 'var(--text-tertiary)', marginBottom: '0.25rem' }}>
            ENGINEERING DATABASE
          </div>
          <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>Karnataka Districts</h2>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            {KARNATAKA_DISTRICTS.length} districts &nbsp;·&nbsp; Seismic · Thermal · Wind · Electrical data
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {[
            { icon: <Activity size={11} />, label: 'Seismic', color: '#b0604f' },
            { icon: <Thermometer size={11} />, label: 'Thermal', color: '#a57c3a' },
            { icon: <Wind size={11} />, label: 'Wind', color: '#4f7d78' },
            { icon: <Zap size={11} />, label: 'Electrical', color: '#5c7d59' },
          ].map(({ icon, label, color }) => (
            <div key={label} style={{
              display: 'flex', alignItems: 'center', gap: '0.3rem',
              background: `${color}12`, border: `1px solid ${color}30`,
              borderRadius: '20px', padding: '0.25rem 0.7rem',
              fontSize: '0.65rem', color, fontWeight: 600,
            }}>
              {icon}{label}
            </div>
          ))}
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 2rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ fontSize: '0.6rem', letterSpacing: '0.1em', color: 'var(--text-tertiary)', textAlign: 'left' }}>
              {['DISTRICT', 'REGION', 'SEISMIC ZONE', 'CLIMATE', 'WIND RISK', 'GRID RELIABILITY'].map(h => (
                <th key={h} style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid var(--border-subtle)', fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {KARNATAKA_DISTRICTS.map((d) => {
              const regionColor = REGION_COLORS[d.region] ?? '#888';
              return (
                <tr
                  key={d.id}
                  style={{ borderBottom: '1px solid var(--border-subtle)', cursor: 'pointer', transition: 'background 0.15s' }}
                  onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(60,52,44,0.024)'}
                  onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'}
                >
                  {/* District */}
                  <td style={{ padding: '0.9rem 0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{
                        width: '34px', height: '34px', borderRadius: '8px',
                        background: `${regionColor}15`, border: `1px solid ${regionColor}30`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      }}>
                        <Database size={15} color={regionColor} />
                      </div>
                      <div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{d.name}</div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)', marginTop: '1px' }}>
                          Pop. {(d.population / 1_000_000).toFixed(1)}M &nbsp;·&nbsp; {d.avgAltitudeM}m
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Region */}
                  <td style={{ padding: '0.9rem 0.75rem' }}>
                    <span style={{
                      background: `${regionColor}15`, border: `1px solid ${regionColor}30`,
                      borderRadius: '20px', padding: '0.15rem 0.6rem',
                      fontSize: '0.65rem', color: regionColor, fontWeight: 600,
                    }}>
                      {d.region}
                    </span>
                  </td>

                  {/* Seismic Zone */}
                  <td style={{ padding: '0.9rem 0.75rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{
                        background: `${ZONE_COLORS[d.seismic.zone]}20`, border: `1px solid ${ZONE_COLORS[d.seismic.zone]}40`,
                        borderRadius: '6px', padding: '0.1rem 0.45rem',
                        fontSize: '0.72rem', color: ZONE_COLORS[d.seismic.zone], fontWeight: 700,
                      }}>
                        Zone {d.seismic.zone}
                      </span>
                      <span style={{
                        fontSize: '0.65rem', color: RISK_COLORS[d.seismic.structuralRisk], fontWeight: 600,
                      }}>
                        {d.seismic.structuralRisk}
                      </span>
                    </div>
                  </td>

                  {/* Climate */}
                  <td style={{ padding: '0.9rem 0.75rem' }}>
                    <span style={{
                      background: `${CLIMATE_COLORS[d.thermal.climateZone]}15`,
                      border: `1px solid ${CLIMATE_COLORS[d.thermal.climateZone]}30`,
                      borderRadius: '20px', padding: '0.15rem 0.6rem',
                      fontSize: '0.65rem', color: CLIMATE_COLORS[d.thermal.climateZone], fontWeight: 600,
                    }}>
                      {d.thermal.climateZone}
                    </span>
                  </td>

                  {/* Wind Risk */}
                  <td style={{ padding: '0.9rem 0.75rem' }}>
                    <WindBar value={d.wind.structuralWindIndex} />
                  </td>

                  {/* Grid Reliability */}
                  <td style={{ padding: '0.9rem 0.75rem' }}>
                    <GridBar value={d.electrical.gridReliabilityPct} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
