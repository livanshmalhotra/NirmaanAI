import { useState } from 'react';
import { MapPin, Crosshair, Search } from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';
import { getBrowserPosition, setLocation, type ChatResponse } from '../../services/api';

const SOURCE_LABEL = { gps: 'GPS', search: 'Search', map: 'Map', coords: 'Coordinates' } as const;

/** Where the building is: set from the browser's location or a place search. */
export function SiteCard() {
  const { state, dispatch } = useBuilding();
  const loc = state.location;
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);

  const apply = (res: ChatResponse) => {
    if (res.updatedState) dispatch({ type: 'SET_STATE', payload: res.updatedState });
    if (res.structuralRisk !== undefined) dispatch({ type: 'SET_RISK', payload: res.structuralRisk });
    // The details after the server's headline (cost change, fallbacks), without markdown
    setNote({ text: res.message.split('\n').slice(1).join(' ').replace(/\*\*/g, ''), tone: res.message_type === 'success' ? 'ok' : 'warn' });
  };

  const run = async (task: () => Promise<ChatResponse>) => {
    setBusy(true);
    setNote(null);
    try {
      apply(await task());
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'Could not set the location.', tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };

  const useMyLocation = () => run(async () => setLocation({ ...(await getBrowserPosition()), source: 'gps' }));
  const search = () => { if (query.trim()) run(() => setLocation({ query: query.trim() })); };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-tertiary)', marginBottom: '0.5rem' }}>
        <MapPin size={11} /> SITE LOCATION
      </div>

      {loc ? (
        <div style={{ fontSize: '0.7rem', lineHeight: 1.45 }}>
          <div style={{ color: '#2b2926', fontWeight: 600 }} title={loc.address}>
            {loc.address ? loc.address.split(',').slice(0, 2).join(',') : `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`}
          </div>
          <div style={{ color: 'var(--text-secondary)' }}>
            {state.district.name} district · {SOURCE_LABEL[loc.source]}
          </div>
          <div style={{ color: 'var(--text-tertiary)', fontSize: '0.62rem', fontVariantNumeric: 'tabular-nums' }}>
            {loc.lat.toFixed(4)}° N, {loc.lng.toFixed(4)}° E
          </div>
          {(loc.approximated || !loc.in_karnataka || loc.offline) && (
            <div style={{ color: '#a57c3a', fontSize: '0.62rem', marginTop: '0.2rem' }}>
              {!loc.in_karnataka
                ? 'Outside Karnataka — using the nearest supported district'
                : loc.offline
                  ? 'Map service unreachable — district picked by distance'
                  : `${loc.reported_district || 'This district'} has no data yet — using the nearest one`}
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)' }}>
          Not set — using {state.district.name} district values.
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.55rem' }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') search(); }}
          placeholder="Town, place or lat, lng"
          disabled={busy}
          style={{ flex: 1, minWidth: 0, background: 'rgba(60,52,44,0.048)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '0.35rem 0.5rem', fontSize: '0.68rem', color: 'var(--text-primary)' }}
        />
        <IconBtn title="Search" onClick={search} disabled={busy || !query.trim()}><Search size={12} /></IconBtn>
        <IconBtn title="Use my current location" onClick={useMyLocation} disabled={busy}><Crosshair size={12} /></IconBtn>
      </div>
      {busy && <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '0.3rem' }}>Locating…</div>}
      {note && note.text && (
        <div style={{ fontSize: '0.6rem', marginTop: '0.3rem', color: note.tone === 'ok' ? 'var(--text-secondary)' : '#a57c3a' }}>{note.text}</div>
      )}
    </div>
  );
}

function IconBtn({ children, title, onClick, disabled }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      title={title} aria-label={title} onClick={onClick} disabled={disabled}
      // padding: 0 overrides the global button padding, which leaves no room for the icon
      style={{ width: '28px', padding: 0, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(79,125,120,0.1)', border: '1px solid rgba(79,125,120,0.25)', borderRadius: '6px', color: '#4f7d78', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}
    >
      {children}
    </button>
  );
}
