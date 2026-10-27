import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Wind, Thermometer, Activity, Sun } from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';
import { fetchClimate, fetchLiveConditions, QUAKE_SEARCH, type ClimateBaseline, type LiveConditions as Live } from '../../services/liveData';

const REFRESH_MS = 10 * 60 * 1000;

/** Real-time weather + recent earthquakes at the site, compared with the site's own recent climate (all from APIs). */
export function LiveConditions() {
  const { state } = useBuilding();
  const district = state.district;
  const [data, setData] = useState<Live | null>(null);
  const [climate, setClimate] = useState<ClimateBaseline | null>(null);
  const [loading, setLoading] = useState(false);

  // Use the exact site once one is set, so weather and quakes are for that spot, not the district HQ
  const lat = state.location?.lat;
  const lng = state.location?.lng;
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const site = lat !== undefined && lng !== undefined ? { lat, lng } : null;
      const live = await fetchLiveConditions({ id: district.id, name: district.name }, signal, site);
      setData(live);
      // Baseline arrives later; live readings show first
      fetchClimate(live.coords[0], live.coords[1], signal)
        .then(c => { if (!signal?.aborted) setClimate(c); })
        .catch(() => { /* baseline unavailable */ });
    } catch { /* aborted */ }
    finally { setLoading(false); }
  }, [district.id, district.name, lat, lng]);

  useEffect(() => {
    const ctrl = new AbortController();
    load(ctrl.signal);
    const t = setInterval(() => load(), REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [load]);

  const w = data?.weather;
  const quakes = data?.quakes;
  const strongest = quakes && quakes.length ? quakes.reduce((a, b) => (b.magnitude > a.magnitude ? b : a)) : null;

  // Live gust as a share of the strongest gust recorded at this spot in the last few years
  const gustVsRecord = w && climate ? Math.round((w.gustKmh / climate.recordGustKmh) * 100) : null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '0.6rem' }}>
        <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: w ? '#5c7d59' : '#8f897f', marginRight: '0.4rem', animation: w ? 'livePulse 2s infinite' : undefined }} />
        <span style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>
          LIVE · {district.name.toUpperCase()}
        </span>
        <button onClick={() => load()} disabled={loading} title="Refresh"
          style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: loading ? 'wait' : 'pointer', padding: 0 }}>
          <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
        </button>
      </div>

      {!data && loading && <div style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>Fetching live data…</div>}

      {data && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
          <Tile icon={<Thermometer size={11} />} color="#a57c3a" label="TEMP"
            value={w ? `${w.temperatureC.toFixed(1)}°C` : '—'}
            sub={w ? `${w.humidityPct}% RH${climate ? ` · hot day ${climate.hotDayC}°C` : ''}` : 'unavailable'}
            warn={!!w && !!climate && w.temperatureC >= climate.hotDayC} />
          <Tile icon={<Wind size={11} />} color="#4f7d78" label="WIND"
            value={w ? `${Math.round(w.windKmh)} km/h` : '—'}
            sub={w ? `gust ${Math.round(w.gustKmh)}${gustVsRecord !== null ? ` · ${gustVsRecord}% of record` : ''}` : 'unavailable'}
            warn={gustVsRecord !== null && gustVsRecord >= 80} />
          <Tile icon={<Sun size={11} />} color="#8c6a2f" label="SOLAR"
            value={w ? `${Math.round(w.solarWm2)} W/m²` : '—'}
            sub={climate ? `avg daily peak ${climate.avgPeakSolarWm2} W/m²` : w ? 'baseline unavailable' : 'unavailable'} />
          <Tile icon={<Activity size={11} />} color="#b0604f" label="QUAKES"
            value={quakes ? String(quakes.length) : '—'}
            sub={quakes
              ? (strongest ? `max M${strongest.magnitude.toFixed(1)}, ${strongest.distanceKm} km` : `none ≥M2 in ${QUAKE_SEARCH.radiusKm} km`)
              : 'unavailable'}
            warn={!!strongest && strongest.magnitude >= 4} />
        </div>
      )}

      {quakes && quakes.length > 0 && (
        <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          {quakes.slice(0, 3).map(q => (
            <a key={q.id} href={q.url} target="_blank" rel="noreferrer"
              style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', textDecoration: 'none', display: 'flex', gap: '0.35rem' }}>
              <b style={{ color: q.magnitude >= 4 ? '#b0604f' : '#a57c3a' }}>M{q.magnitude.toFixed(1)}</b>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.place}</span>
              <span style={{ color: 'var(--text-tertiary)' }}>{new Date(q.time).toLocaleDateString()}</span>
            </a>
          ))}
        </div>
      )}

      {data && (
        <div style={{ fontSize: '0.55rem', color: 'var(--text-tertiary)', marginTop: '0.45rem' }}>
          Open-Meteo &amp; USGS at {data.coords[0].toFixed(3)}, {data.coords[1].toFixed(3)}
          {data.coordsSource === 'site' ? ' (your site)' : data.coordsSource === 'geocoded' ? ` (${district.name}, geocoded)` : ' (district HQ, offline fallback)'}
          {climate && ` · baseline ${climate.from} → ${climate.to}`}
          {` · quakes within ${QUAKE_SEARCH.radiusKm} km, last ${QUAKE_SEARCH.days} days · updated ${new Date(data.fetchedAt).toLocaleTimeString()}`}
        </div>
      )}
      <style>{`@keyframes livePulse{0%,100%{opacity:1}50%{opacity:0.35}} @keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Tile({ icon, color, label, value, sub, warn }: {
  icon: React.ReactNode; color: string; label: string; value: string; sub: string; warn?: boolean;
}) {
  return (
    <div style={{
      background: warn ? 'rgba(176,96,79,0.08)' : 'rgba(60,52,44,0.036)',
      border: `1px solid ${warn ? 'rgba(176,96,79,0.4)' : 'var(--border-subtle)'}`,
      borderRadius: '8px', padding: '0.45rem 0.5rem',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.1em', color }}>
        {icon} {label}
      </div>
      <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#2b2926', marginTop: '0.15rem' }}>{value}</div>
      <div style={{ fontSize: '0.56rem', color: 'var(--text-tertiary)', marginTop: '0.1rem', lineHeight: 1.3 }}>{sub}</div>
    </div>
  );
}
