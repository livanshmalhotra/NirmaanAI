import { useCallback, useEffect, useState } from 'react';
import {
  Activity, Thermometer, AlertTriangle, CheckCircle, MapPin, Play, ExternalLink, Loader2, Database,
} from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';
import {
  fetchSeismicAnalysis, type SeismicAnalysis, type SeismicReport, type SoilType,
} from '../../services/api';
import { fetchClimate, fetchLiveConditions, type ClimateBaseline, type LiveConditions } from '../../services/liveData';

/* IS 1893 (Part 1):2016 Table 4, abridged */
const SOIL_HELP: Record<SoilType, string> = {
  I: 'Rock or hard soil — well-graded gravel/sand, or sand/clay with SPT N > 30',
  II: 'Medium or stiff soil — poorly graded sand or low-compressibility silt/clay, N 10–30',
  III: 'Soft soil — all soils other than SP with N < 10 (silts and clays of medium/high compressibility)',
};
const IMPORTANCE: { value: number; label: string }[] = [
  { value: 1.0, label: '1.0 — homes and other buildings' },
  { value: 1.2, label: '1.2 — residential/commercial, > 200 occupants' },
  { value: 1.5, label: '1.5 — schools, hospitals, lifeline buildings' },
];

const card: React.CSSProperties = {
  background: 'rgba(60,52,44,0.024)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '1rem 1.1rem',
};
const label: React.CSSProperties = { fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)' };
const select: React.CSSProperties = {
  background: 'rgba(60,52,44,0.06)', border: '1px solid var(--border-subtle)', borderRadius: '7px',
  color: '#2b2926', fontSize: '0.75rem', padding: '0.35rem 0.5rem', marginTop: '0.25rem', width: '100%',
};

export function SimulationsPage() {
  const { state } = useBuilding();
  const floors = state.floors.length;

  const [soil, setSoil] = useState<SoilType | 'auto'>('auto');
  const [frame, setFrame] = useState<'OMRF' | 'SMRF'>('SMRF');
  const [importance, setImportance] = useState(1.0);
  const [infill, setInfill] = useState(true);
  const [report, setReport] = useState<SeismicReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true); setError(null);
    try {
      setReport(await fetchSeismicAnalysis({ soil, frame, importance, infill }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setRunning(false); }
  }, [soil, frame, importance, infill]);

  // Run once on open, and again whenever the inputs change
  useEffect(() => { run(); }, [run]);

  const zone = report?.zone.zone ?? null;
  const analysisError = report?.analysis.error ?? null;
  const analysis = report && !analysisError ? report.analysis as SeismicAnalysis : null;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div style={{ padding: '1.1rem 2rem', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ fontSize: '0.65rem', letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>ENGINEERING ANALYSIS · REAL DATA</div>
        <h2 style={{ margin: '0.15rem 0 0', fontSize: '1.3rem', fontWeight: 700 }}>Simulations</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.25rem', fontSize: '0.75rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
          <MapPin size={12} color="#4f7d78" />
          <span style={{ color: '#4f7d78', fontWeight: 600 }}>{report?.site.label ?? state.district.name}</span>
          {report && <span style={{ color: 'var(--text-tertiary)' }}>· {report.site.lat.toFixed(4)}°N, {report.site.lon.toFixed(4)}°E ({report.site.source})</span>}
          <span style={{ color: 'var(--text-tertiary)' }}>· {floors} floor{floors !== 1 ? 's' : ''}</span>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 2rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* ── Seismic analysis ── */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.8rem' }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: '#b0604f18', border: '1px solid #b0604f40', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#b0604f' }}>
              <Activity size={18} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>Seismic Analysis — IS 1893 (Part 1):2016</div>
              <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>
                Equivalent static method (cl. 7.6) · zone from the BMTPC / BIS zone map · live USGS and SoilGrids data
              </div>
            </div>
            <button onClick={run} disabled={running} style={{
              display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.45rem 0.9rem', borderRadius: 8, fontSize: '0.75rem', fontWeight: 700,
              background: '#b0604f20', border: '1px solid #b0604f50', color: '#9a5040', cursor: running ? 'wait' : 'pointer',
            }}>
              {running ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={13} />}
              {running ? 'Fetching live data…' : 'Re-run'}
            </button>
          </div>

          {/* Inputs the user decides */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.6rem' }}>
            <label style={label}>
              SOIL TYPE (TABLE 4)
              <select style={select} value={soil} onChange={e => setSoil(e.target.value as SoilType | 'auto')}>
                <option value="auto">Auto — from SoilGrids if available</option>
                <option value="I">Type I — rock / hard</option>
                <option value="II">Type II — medium / stiff</option>
                <option value="III">Type III — soft</option>
              </select>
            </label>
            <label style={label}>
              FRAME (TABLE 9)
              <select style={select} value={zone && zone !== 'II' ? 'SMRF' : frame} onChange={e => setFrame(e.target.value as 'OMRF' | 'SMRF')}>
                <option value="SMRF">SMRF — special, ductile (R = 5)</option>
                <option value="OMRF" disabled={!!zone && zone !== 'II'}>OMRF — ordinary (R = 3){zone && zone !== 'II' ? ' — not allowed in Zone ' + zone : ''}</option>
              </select>
            </label>
            <label style={label}>
              IMPORTANCE (TABLE 8)
              <select style={select} value={importance} onChange={e => setImportance(parseFloat(e.target.value))}>
                {IMPORTANCE.map(i => <option key={i.value} value={i.value}>{i.label}</option>)}
              </select>
            </label>
            <label style={label}>
              WALLS
              <select style={select} value={infill ? 'infill' : 'bare'} onChange={e => setInfill(e.target.value === 'infill')}>
                <option value="infill">RC frame with brick infill</option>
                <option value="bare">Bare RC frame</option>
              </select>
            </label>
          </div>

          {error && <Banner tone="error">{error}</Banner>}
          {!report && running && <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)', marginTop: '0.8rem' }}>Querying USGS and SoilGrids…</div>}

          {report && (
            <>
              {/* Zone + soil */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.6rem', marginTop: '0.9rem' }}>
                <Panel title="SEISMIC ZONE" tone={zone === 'II' ? 'ok' : 'warn'}>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>
                    {zone ? `Zone ${zone}` : 'Unknown'}{report.zone.Z !== null && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}> · Z = {report.zone.Z}</span>}
                  </div>
                  <ul style={{ margin: '0.35rem 0 0', paddingLeft: '1rem', fontSize: '0.66rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    {report.zone.basis.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </Panel>
                <Panel title="SOIL" tone={report.soil_used ? 'ok' : 'warn'}>
                  <div style={{ fontSize: '1rem', fontWeight: 800 }}>
                    {report.soil_used ? `Type ${report.soil_used}` : 'Not known — choose above'}
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', fontWeight: 600 }}> · {report.soil_source}</span>
                  </div>
                  {report.soil_used && <div style={{ fontSize: '0.66rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>{SOIL_HELP[report.soil_used]}</div>}
                  <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)', marginTop: '0.35rem', lineHeight: 1.5 }}>
                    SoilGrids: {report.soil_texture.reason}
                  </div>
                </Panel>
              </div>

              {analysisError && <Banner tone="warn">{analysisError}</Banner>}
              {analysis && <AnalysisResult a={analysis} />}

              <QuakeHistory report={report} />
              <Sources report={report} analysis={analysis} />
            </>
          )}
        </div>

        <SiteClimate />
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function AnalysisResult({ a }: { a: SeismicAnalysis }) {
  const gov = a.directions.find(d => d.direction === a.governing) ?? a.directions[0];
  const maxQ = Math.max(...gov.forces.map(f => f.V_kN), 1);
  return (
    <>
      {/* Headline numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem', marginTop: '0.8rem' }}>
        <Stat label="DESIGN BASE SHEAR VB" value={`${gov.VB_kN}`} unit="kN" sub={`${gov.VB_percent_W} % of W · ${gov.direction}`} accent />
        <Stat label="SEISMIC WEIGHT W" value={`${a.W_kN}`} unit="kN" sub={`${a.levels.length} levels · cl. 7.4`} />
        <Stat label="PERIOD Ta" value={`${gov.Ta_s}`} unit="s" sub={gov.Ta_rule.split(':')[0]} />
        <Stat label="Sa/g" value={`${gov.Sa_g}`} unit="" sub={`Soil Type ${a.soil} · cl. 6.4.2(a)`} />
        <Stat label="Ah" value={`${gov.Ah}`} unit="" sub={gov.min_governs ? `Table 7 minimum ${gov.Ah_min} governs` : `≥ minimum ${gov.Ah_min}`} />
        <Stat label="HEIGHT h" value={`${a.height_m}`} unit="m" sub={`${a.storey_height_m} m storeys`} />
      </div>

      {/* Floor forces */}
      <div style={{ marginTop: '0.9rem' }}>
        <div style={label}>LATERAL FORCES BY FLOOR — {gov.direction.toUpperCase()} (Qi = VB·Wi·hi² / ΣWj·hj², cl. 7.6.3)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.4rem' }}>
          {[...gov.forces].reverse().map(f => {
            const lvl = a.levels[f.level - 1];
            return (
              <div key={f.level} style={{ display: 'grid', gridTemplateColumns: '8rem 1fr 7rem 7rem 7rem', gap: '0.5rem', alignItems: 'center', fontSize: '0.7rem' }}>
                <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>Level {f.level} · {lvl.h_m} m</span>
                <div style={{ height: 8, background: 'rgba(60,52,44,0.06)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${(f.V_kN / maxQ) * 100}%`, height: '100%', background: 'linear-gradient(90deg,#b0604f,#a57c3a)' }} />
                </div>
                <span>W {lvl.W_kN} kN</span>
                <span>Q {f.Q_kN} kN</span>
                <span style={{ fontWeight: 700 }}>V {f.V_kN} kN</span>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: '0.64rem', color: 'var(--text-tertiary)', marginTop: '0.35rem' }}>
          Overturning moment at base {gov.overturning_kNm} kN·m. Other direction: VB {a.directions.find(d => d !== gov)?.VB_kN} kN (Ta {a.directions.find(d => d !== gov)?.Ta_s} s).
        </div>
      </div>

      {/* Code checks */}
      <div style={{ marginTop: '0.9rem' }}>
        <div style={label}>CODE CHECKS</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.4rem' }}>
          {a.checks.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: '0.45rem', fontSize: '0.7rem', lineHeight: 1.45, color: c.ok ? 'var(--text-secondary)' : '#8c6a2f' }}>
              {c.ok ? <CheckCircle size={14} color="#5c7d59" style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={14} color="#a57c3a" style={{ flexShrink: 0, marginTop: 1 }} />}
              <span><b>{c.rule}:</b> {c.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function QuakeHistory({ report }: { report: SeismicReport }) {
  const q = report.earthquakes;
  return (
    <div style={{ marginTop: '0.9rem' }}>
      <div style={label}>RECORDED EARTHQUAKES WITHIN {q.radius_km} KM</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.6rem', marginTop: '0.4rem' }}>
        <Panel title={`USGS CATALOGUE · M ≥ 3 SINCE 1900 · ${q.usgs.length} EVENT${q.usgs.length === 1 ? '' : 'S'}`}>
          {q.usgs_error ? <div style={{ fontSize: '0.68rem', color: '#9a5040' }}>{q.usgs_error}</div>
            : q.usgs.length === 0 ? <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>No M ≥ 3 events recorded in this radius — USGS coverage of South India before the 1970s is sparse.</div>
            : q.usgs.slice(0, 8).map((e, i) => (
              <a key={i} href={e.url} target="_blank" rel="noreferrer" style={{ display: 'flex', gap: '0.4rem', fontSize: '0.68rem', color: 'var(--text-secondary)', textDecoration: 'none', padding: '0.1rem 0' }}>
                <b style={{ color: e.magnitude >= 5 ? '#b0604f' : '#a57c3a', width: '4.2rem' }}>M{e.magnitude.toFixed(1)} {e.mag_type}</b>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.place}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{new Date(e.time).getFullYear()} · {e.distance_km} km</span>
              </a>
            ))}
        </Panel>
        <Panel title="IMD EPICENTRES M ≥ 5 (ON BMTPC MAP)">
          {q.map_events.length === 0 ? <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>None within {q.radius_km} km.</div>
            : q.map_events.map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: '0.4rem', fontSize: '0.68rem', color: 'var(--text-secondary)', padding: '0.1rem 0' }}>
                <b style={{ color: e.magnitude >= 6 ? '#b0604f' : '#a57c3a', width: '3.2rem' }}>M{e.magnitude.toFixed(1)}</b>
                <span style={{ flex: 1 }}>{e.year} · {e.lat.toFixed(2)}°N, {e.lon.toFixed(2)}°E</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{e.distance_km} km</span>
              </div>
            ))}
        </Panel>
      </div>
    </div>
  );
}

function Sources({ report, analysis }: { report: SeismicReport; analysis: SeismicAnalysis | null }) {
  const s = report.sources;
  return (
    <details style={{ marginTop: '0.9rem' }}>
      <summary style={{ ...label, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
        <Database size={12} /> EVERY INPUT AND ITS SOURCE
      </summary>
      {analysis && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.68rem', marginTop: '0.5rem' }}>
          <tbody>
            {analysis.inputs.map(i => (
              <tr key={i.name} style={{ borderBottom: '1px solid rgba(60,52,44,0.06)' }}>
                <td style={{ padding: '0.3rem 0.4rem', color: 'var(--text-secondary)' }}>{i.name}</td>
                <td style={{ padding: '0.3rem 0.4rem', fontWeight: 700 }}>{String(i.value)}</td>
                <td style={{ padding: '0.3rem 0.4rem', color: 'var(--text-tertiary)' }}>{i.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {analysis && (
        <div style={{ fontSize: '0.66rem', color: '#8c6a2f', marginTop: '0.5rem', lineHeight: 1.6 }}>
          Engineering assumptions (not code values): {analysis.assumptions.join(' · ')}
        </div>
      )}
      <ul style={{ fontSize: '0.66rem', color: 'var(--text-secondary)', lineHeight: 1.7, paddingLeft: '1rem', marginTop: '0.5rem' }}>
        <li>{s.zone_map.title} — {s.zone_map.publisher}. Basis: {s.zone_map.basis}. <SourceLink href={s.zone_map.url} /> (retrieved {s.zone_map.retrieved})</li>
        <li>{s.annex_e.title} — {s.annex_e.publisher}, PDF page {s.annex_e.pdf_page}. <SourceLink href={s.annex_e.url} /></li>
        <li>{s.usgs}</li>
        <li>{s.soilgrids}</li>
        <li>Code text: {s.code}. The 2025 revision of IS 1893 was withdrawn in March 2026, so the 2016 edition applies.</li>
      </ul>
    </details>
  );
}

/* ── Measured site climate (Open-Meteo forecast + ERA5 archive) ── */
function SiteClimate() {
  const { state } = useBuilding();
  const district = state.district;
  const lat = state.location?.lat;
  const lng = state.location?.lng;
  const [live, setLive] = useState<LiveConditions | null>(null);
  const [climate, setClimate] = useState<ClimateBaseline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    const site = lat !== undefined && lng !== undefined ? { lat, lng } : null;
    fetchLiveConditions({ id: district.id, name: district.name }, ctrl.signal, site)
      .then(l => { setLive(l); return fetchClimate(l.coords[0], l.coords[1], ctrl.signal); })
      .then(setClimate)
      .catch(err => { if (!ctrl.signal.aborted) setError(String(err)); });
    return () => ctrl.abort();
  }, [district.id, district.name, lat, lng]);

  const w = live?.weather;
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.7rem' }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, background: '#a57c3a18', border: '1px solid #a57c3a40', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#a57c3a' }}>
          <Thermometer size={18} />
        </div>
        <div>
          <div style={{ fontSize: '0.95rem', fontWeight: 700 }}>Site Climate — measured</div>
          <div style={{ fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>Open-Meteo live weather and its ERA5 reanalysis archive (ECMWF) for this site</div>
        </div>
      </div>
      {error && <Banner tone="error">{error}</Banner>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
        <Stat label="TEMPERATURE NOW" value={w ? `${w.temperatureC.toFixed(1)}` : '…'} unit="°C" sub={w ? `${w.humidityPct} % RH` : ''} />
        <Stat label="WIND NOW" value={w ? `${Math.round(w.windKmh)}` : '…'} unit="km/h" sub={w ? `gust ${Math.round(w.gustKmh)} km/h` : ''} />
        <Stat label="SOLAR NOW" value={w ? `${Math.round(w.solarWm2)}` : '…'} unit="W/m²" sub="shortwave radiation" />
        <Stat label="HOT DAY (95TH PCT)" value={climate ? `${climate.hotDayC}` : '…'} unit="°C" sub={climate ? `daily max, ${climate.from} → ${climate.to}` : 'loading 3-year archive'} />
        <Stat label="STRONGEST GUST" value={climate ? `${climate.recordGustKmh}` : '…'} unit="km/h" sub={climate ? `${climate.years}-year record` : ''} />
        <Stat label="PEAK SOLAR (AVG)" value={climate ? `${climate.avgPeakSolarWm2}` : '…'} unit="W/m²" sub="daily peak, last 12 months" />
      </div>
      <div style={{ fontSize: '0.64rem', color: 'var(--text-tertiary)', marginTop: '0.6rem', lineHeight: 1.6 }}>
        These are measured/reanalysed values, not design values. A wind-load design needs the IS 875 (Part 3) basic wind speed for the
        site, and electrical load flow needs utility data — neither has an authentic public live source, so they're not simulated here.
      </div>
    </div>
  );
}

/* ── Small pieces ── */
function Panel({ title, tone, children }: { title: string; tone?: 'ok' | 'warn'; children: React.ReactNode }) {
  const c = tone === 'warn' ? '#a57c3a' : tone === 'ok' ? '#5c7d59' : 'var(--border-subtle)';
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderLeft: `3px solid ${c}`, borderRadius: 8, padding: '0.6rem 0.75rem', background: 'rgba(60,52,44,0.024)' }}>
      <div style={{ ...label, marginBottom: '0.3rem' }}>{title}</div>
      {children}
    </div>
  );
}

function Stat({ label: l, value, unit, sub, accent }: { label: string; value: string; unit: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? 'rgba(176,96,79,0.08)' : 'rgba(60,52,44,0.036)', border: `1px solid ${accent ? 'rgba(176,96,79,0.35)' : 'rgba(60,52,44,0.072)'}`, borderRadius: 8, padding: '0.5rem 0.6rem' }}>
      <div style={label}>{l}</div>
      <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#2b2926', marginTop: '0.15rem' }}>
        {value}<span style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)', marginLeft: 3 }}>{unit}</span>
      </div>
      {sub && <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '0.1rem' }}>{sub}</div>}
    </div>
  );
}

function Banner({ tone, children }: { tone: 'error' | 'warn'; children: React.ReactNode }) {
  const c = tone === 'error' ? '#9a5040' : '#8c6a2f';
  return <div style={{ marginTop: '0.7rem', fontSize: '0.72rem', color: c, background: `${c}14`, border: `1px solid ${c}40`, borderRadius: 8, padding: '0.5rem 0.65rem' }}>{children}</div>;
}

function SourceLink({ href }: { href: string }) {
  return <a href={href} target="_blank" rel="noreferrer" style={{ color: '#4f7d78', display: 'inline-flex', alignItems: 'center', gap: 2 }}>source <ExternalLink size={10} /></a>;
}
