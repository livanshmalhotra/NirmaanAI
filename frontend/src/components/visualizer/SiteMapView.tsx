import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import type { Feature } from 'geojson';
import 'maplibre-gl/dist/maplibre-gl.css';
import { X, Search, Compass, MapPin } from 'lucide-react';
import { useBuilding, type BuildingState } from '../../context/BuildingContext';
import { setLocation, setHeading, geocode, type ChatResponse } from '../../services/api';

/*
 * Real-world map of the site: satellite imagery, OpenStreetMap buildings in 3D,
 * and the user's own house extruded from its floor footprints at the marked
 * point. Free, key-less tiles: Esri World Imagery + OpenFreeMap (OSM).
 * Clicking the map marks the site; nothing is taken from GPS or a default.
 */

const FT = 0.3048;            // metres per foot
const STOREY_M = 3;           // storey height used for the extrusion
const KARNATAKA: [number, number] = [75.7, 15.0];
const SITE_ZOOM = 19.2;
const CHECK_ZOOM = 16;      // building outlines (z14 tiles) are reliably loaded from here     // close enough that a single house fills a good part of the view

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      maxzoom: 18,   // z19 has gaps (black squares) in places; z18 is stretched instead
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    },
    osm: {
      type: 'vector',
      url: 'https://tiles.openfreemap.org/planet',
      attribution: '© OpenStreetMap contributors · OpenFreeMap',
    },
  },
  layers: [
    { id: 'satellite', type: 'raster', source: 'satellite' },
    // Invisible: only makes the map load OSM building tiles. These tiles merge many
    // buildings into one MultiPolygon, so filters can't drop a single building — the
    // buildings are drawn from a per-building copy instead (see syncOsmBuildings).
    {
      id: 'osm-loader', type: 'fill', source: 'osm', 'source-layer': 'building', minzoom: 14,
      paint: { 'fill-opacity': 0 },
    },
  ],
};

type LngLat = { lat: number; lng: number };

/** Plot-local feet (x right, z towards the front/road) → [lng, lat] at the site, turned to `heading`. */
function projector(center: LngLat, plotW: number, plotD: number, headingDeg: number) {
  const h = (headingDeg * Math.PI) / 180;
  const mPerLng = 111_320 * Math.cos((center.lat * Math.PI) / 180);
  return (x: number, z: number): [number, number] => {
    const cx = (x - plotW / 2) * FT, cz = (z - plotD / 2) * FT;
    const east = cx * Math.cos(h) + cz * Math.sin(h);
    const north = -cx * Math.sin(h) + cz * Math.cos(h);
    return [center.lng + east / mPerLng, center.lat + north / 110_540];
  };
}

/* ── The house, built from extruded boxes so it reads as a house, not a block ──
   Per floor: a protruding slab band, cream walls, glass windows along every
   outside wall; a front door on the ground floor; a stepped hip roof with eaves
   on top. Plan units are feet (building frame, z towards the road); heights metres. */
const WALL = '#ece3d2', SLAB = '#a8a29e', GLASS = '#8fa5c2', DOOR = '#78350f', ROOF = ['#9a3412', '#b45309'];
const WINDOW_EVERY_FT = 10, WINDOW_W_FT = 4, PROUD_FT = 0.35;
const ROOF_STEPS = 6, ROOF_STEP_M = 0.32, EAVES_FT = 1.2;

type Ring = (x: number, z: number, w: number, d: number) => [number, number][][];

function houseFeatures(floors: BuildingState['floors'], ring: Ring): Feature[] {
  const out: Feature[] = [];
  const box = (x: number, z: number, w: number, d: number, base: number, top: number, color: string) =>
    out.push({ type: 'Feature', properties: { base, height: top, color }, geometry: { type: 'Polygon', coordinates: ring(x, z, w, d) } });

  // Front door: middle of the front-most wall of the ground floor
  const ground = floors[0]?.footprint ?? [];
  const front = ground.reduce<(typeof ground)[number] | null>((a, p) => (!a || p.z + p.d > a.z + a.d ? p : a), null);
  const doorX = front ? front.x + front.w / 2 : null;
  if (front && doorX !== null) box(doorX - 1.75, front.z + front.d, 3.5, PROUD_FT, 0, 2.2, DOOR);

  floors.forEach((f, i) => {
    const base = i * STOREY_M, top = base + STOREY_M;
    const inside = (x: number, z: number) => f.footprint.some(p => x > p.x && x < p.x + p.w && z > p.z && z < p.z + p.d);
    for (const p of f.footprint) {
      box(p.x - 0.4, p.z - 0.4, p.w + 0.8, p.d + 0.8, base, base + 0.3, SLAB);   // floor slab band
      box(p.x, p.z, p.w, p.d, base + 0.3, top, WALL);                           // walls
      // Windows on each wall, skipping walls shared with another part of the same floor
      const walls = [
        { along: 'x', at: p.z + p.d, out: 1, from: p.x, len: p.w },
        { along: 'x', at: p.z, out: -1, from: p.x, len: p.w },
        { along: 'z', at: p.x + p.w, out: 1, from: p.z, len: p.d },
        { along: 'z', at: p.x, out: -1, from: p.z, len: p.d },
      ] as const;
      for (const wall of walls) {
        if (wall.len < WINDOW_W_FT + 2) continue;
        const n = Math.max(1, Math.floor(wall.len / WINDOW_EVERY_FT));
        for (let k = 0; k < n; k++) {
          const c = wall.from + ((k + 0.5) * wall.len) / n;
          const probe = wall.along === 'x' ? inside(c, wall.at + wall.out * 0.6) : inside(wall.at + wall.out * 0.6, c);
          if (probe) continue;                                                    // interior wall
          if (i === 0 && p === front && wall.along === 'x' && wall.out === 1 && doorX !== null && Math.abs(c - doorX) < 4) continue;
          const o = wall.out > 0 ? wall.at : wall.at - PROUD_FT;
          if (wall.along === 'x') box(c - WINDOW_W_FT / 2, o, WINDOW_W_FT, PROUD_FT, base + 0.9, base + 2.2, GLASS);
          else box(o, c - WINDOW_W_FT / 2, PROUD_FT, WINDOW_W_FT, base + 0.9, base + 2.2, GLASS);
        }
      }
    }
  });

  // Stepped hip roof with overhanging eaves on the top floor
  const roofBase = floors.length * STOREY_M;
  for (const p of floors[floors.length - 1]?.footprint ?? []) {
    const half = Math.min(p.w, p.d) / 2 + EAVES_FT;
    for (let k = 0; k < ROOF_STEPS; k++) {
      const inset = -EAVES_FT + (k * half) / ROOF_STEPS;
      box(p.x + inset, p.z + inset, p.w - 2 * inset, p.d - 2 * inset,
        roofBase + k * ROOF_STEP_M, roofBase + (k + 1) * ROOF_STEP_M, ROOF[k % 2]);
    }
  }
  return out;
}

function plotSize(state: BuildingState): [number, number] {
  return [state.site.plot_width_ft || state.site.base_width_ft || 40, state.site.plot_depth_ft || state.site.base_depth_ft || 30];
}

/** The plot outline as [lng, lat] corners if the site were at `center`, turned to `heading`. */
function plotRing(state: BuildingState, center: LngLat, heading: number): [number, number][] {
  const [w, d] = plotSize(state);
  const at = projector(center, w, d, heading);
  return [at(0, 0), at(w, 0), at(w, d), at(0, d), at(0, 0)];
}

function siteGeoJSON(state: BuildingState, center: LngLat | null, heading: number) {
  const empty = { type: 'FeatureCollection' as const, features: [] as Feature[] };
  if (!center) return { house: empty, plot: empty };
  const { site } = state;
  const [plotW, plotD] = plotSize(state);
  const at = projector(center, plotW, plotD, heading);
  const ring = (x: number, z: number, w: number, d: number) => [[at(x, z), at(x + w, z), at(x + w, z + d), at(x, z + d), at(x, z)]];

  const floors = [...state.floors].sort((a, b) => a.number - b.number);
  const house = houseFeatures(floors, (x, z, w, d) => ring(site.building_x + x, site.building_z + z, w, d));
  // Parking / gardens as low slabs
  for (const feat of site.features) {
    house.push({
      type: 'Feature',
      properties: { base: 0, height: 0.2, color: feat.type === 'garden' ? '#4d7c0f' : '#57534e' },
      geometry: { type: 'Polygon', coordinates: ring(feat.x, feat.z, feat.w, feat.d) },
    });
  }
  const plot: Feature[] = [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: ring(0, 0, plotW, plotD) } }];
  return { house: { ...empty, features: house }, plot: { ...empty, features: plot } };
}

export function SiteMapView({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useBuilding();
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [ready, setReady] = useState(false);
  // Shown straight away on click, before the server confirms the new site
  const [pending, setPending] = useState<LngLat | null>(null);
  const [heading, setHeadingLocal] = useState(state.location?.heading_deg ?? 0);
  // Follow the saved heading when it changes elsewhere (e.g. state loaded or reset)
  const savedHeading = state.location?.heading_deg ?? 0;
  const [prevSaved, setPrevSaved] = useState(savedHeading);
  if (savedHeading !== prevSaved) {
    setPrevSaved(savedHeading);
    setHeadingLocal(savedHeading);
  }
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Popup when the house can't go where the user asked (a building is already there)
  const [blocked, setBlocked] = useState<{ title: string; message: string } | null>(null);
  // The saved site overlaps an existing building (e.g. set earlier by GPS)
  const [siteOccupied, setSiteOccupied] = useState(false);

  const siteLat = pending?.lat ?? state.location?.lat;
  const siteLng = pending?.lng ?? state.location?.lng;
  const center = useMemo<LngLat | null>(
    () => (siteLat !== undefined && siteLng !== undefined ? { lat: siteLat, lng: siteLng } : null),
    [siteLat, siteLng],
  );
  const geo = useMemo(() => siteGeoJSON(state, center, heading), [state, center, heading]);

  const apply = (res: ChatResponse) => {
    if (res.updatedState) dispatch({ type: 'SET_STATE', payload: res.updatedState });
    if (res.structuralRisk !== undefined) dispatch({ type: 'SET_RISK', payload: res.structuralRisk });
    const detail = res.message.split('\n')[0].replace(/\*\*/g, '').replace(/^📍\s*/, '');
    setNote(res.updatedState ? detail : res.message);
  };

  const pick = async (loc: LngLat) => {
    const map = mapRef.current;
    if (!map) return;
    // Building outlines only load when zoomed in — zoom to the spot first, then let the user pick
    if (map.getZoom() < CHECK_ZOOM) {
      map.flyTo({ center: [loc.lng, loc.lat], zoom: SITE_ZOOM, pitch: 60, duration: 1400 });
      setNote('Zoomed in — now click an open spot (no building) to place the house.');
      return;
    }
    const hit = occupiedBy(map, plotRing(state, loc, heading));
    if (hit) {
      setBlocked({
        title: 'A building is already here',
        message: `Your ${plotSize(state).join(' × ')} ft plot would overlap ${hit > 1 ? `${hit} existing buildings` : 'an existing building'}. Click an open area — empty land with no building on the map.`,
      });
      return;
    }
    setPending(loc);
    setBusy(true);
    try { apply(await setLocation({ ...loc, source: 'map' })); }
    catch (err) { setNote(err instanceof Error ? err.message : 'Could not set the site.'); }
    finally { setPending(null); setBusy(false); }
  };

  // Search only moves the map; the house is placed by clicking, so every placement is checked
  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const place = await geocode(query.trim());
      mapRef.current?.flyTo({ center: [place.lng, place.lat], zoom: SITE_ZOOM, pitch: 60, duration: 1600 });
      setNote(`Found ${place.address.split(',').slice(0, 2).join(',') || query.trim()} — click an open spot to place the house.`);
    }
    catch (err) { setNote(err instanceof Error ? err.message : 'Search failed.'); }
    finally { setBusy(false); }
  };

  const saveHeading = async () => {
    if (!state.location) return;
    const map = mapRef.current;
    if (map && heading !== savedHeading && occupiedBy(map, plotRing(state, state.location, heading))) {
      setHeadingLocal(savedHeading);
      setBlocked({ title: "Can't turn the house that way", message: 'At that angle the plot would overlap an existing building.' });
      return;
    }
    try { dispatch({ type: 'SET_STATE', payload: await setHeading(heading) }); }
    catch (err) { setNote(err instanceof Error ? err.message : 'Could not save the rotation.'); }
  };

  // Create the map once
  const pickRef = useRef(pick);
  pickRef.current = pick;
  useEffect(() => {
    if (!container.current) return;
    const start = state.location;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: start ? [start.lng, start.lat] : KARNATAKA,
      zoom: start ? SITE_ZOOM : 6.2,
      pitch: start ? 60 : 0,
      bearing: start ? -25 : 0,
      maxPitch: 75,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    map.on('load', () => {
      // maxzoom 24: the default (18) loses the house when zoomed right in on a single plot
      map.addSource('osm-copy', { type: 'geojson', maxzoom: 24, data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'osm-buildings', type: 'fill-extrusion', source: 'osm-copy', minzoom: 14,
        paint: {
          'fill-extrusion-color': '#a8a29e',
          'fill-extrusion-height': ['get', 'h'],
          'fill-extrusion-base': ['get', 'b'],
          'fill-extrusion-opacity': 0.7,
        },
      });
      map.addSource('plot', { type: 'geojson', maxzoom: 24, data: { type: 'FeatureCollection', features: [] } });
      map.addSource('house', { type: 'geojson', maxzoom: 24, data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'plot-fill', type: 'fill', source: 'plot', paint: { 'fill-color': '#b3bc8a', 'fill-opacity': 0.15 } });
      map.addLayer({ id: 'plot-line', type: 'line', source: 'plot', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({
        id: 'house', type: 'fill-extrusion', source: 'house',
        paint: {
          'fill-extrusion-color': ['get', 'color'],
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'base'],
          'fill-extrusion-opacity': 0.95,
        },
      });
      setReady(true);
    });
    map.on('click', e => { pickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng }); });
    // Newly loaded tiles bring more buildings to copy
    map.on('idle', () => setSiteOccupied(syncOsmBuildings(map, plotRingRef.current)));
    map.getCanvas().style.cursor = 'crosshair';
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Redraw the house whenever the building, site or rotation changes
  const plotRingRef = useRef<[number, number][] | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    (map.getSource('house') as GeoJSONSource | undefined)?.setData(geo.house);
    (map.getSource('plot') as GeoJSONSource | undefined)?.setData(geo.plot);
    const plot = geo.plot.features[0]?.geometry;
    plotRingRef.current = plot?.type === 'Polygon' ? (plot.coordinates[0] as [number, number][]) : null;
    setSiteOccupied(syncOsmBuildings(map, plotRingRef.current));
  }, [ready, geo]);

  // Fly to the site when it is first set or moved
  const lastFlown = useRef<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !center) return;
    const key = `${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
    if (key === lastFlown.current) return;
    lastFlown.current = key;
    map.flyTo({ center: [center.lng, center.lat], zoom: Math.max(map.getZoom(), SITE_ZOOM), pitch: 60, bearing: map.getBearing() || -25, duration: 1600 });
  }, [ready, center]);

  const floors = state.floors.length;
  const heightM = floors * STOREY_M + (floors ? ROOF_STEPS * ROOF_STEP_M : 0);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 2500, background: 'rgba(60,52,44,0.245)', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', padding: '0.6rem 1rem', background: '#fbfaf7', borderBottom: '1px solid var(--border-subtle)' }}>
        <MapPin size={16} color="#4f7d78" />
        <span style={{ fontWeight: 800, fontSize: '0.9rem', color: '#2b2926' }}>Site on map</span>
        <div style={{ display: 'flex', gap: '0.35rem', flex: '1 1 260px', maxWidth: '420px' }}>
          <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') search(); }}
            placeholder="Search a place, or click the map" disabled={busy}
            style={{ flex: 1, minWidth: 0, background: 'rgba(60,52,44,0.06)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '0.4rem 0.6rem', fontSize: '0.78rem', color: 'var(--text-primary)' }} />
          <button onClick={search} disabled={busy || !query.trim()} title="Search"
            style={{ padding: '0 0.6rem', borderRadius: '6px', border: '1px solid rgba(79,125,120,0.35)', background: 'rgba(79,125,120,0.12)', color: '#4f7d78', cursor: 'pointer' }}>
            <Search size={14} />
          </button>
        </div>
        <label title="Which way the front (road side) of the house faces"
          style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.72rem', color: 'var(--text-secondary)', opacity: state.location ? 1 : 0.4 }}>
          <Compass size={14} /> Front faces
          <input type="range" min={0} max={359} value={Math.round(heading)} disabled={!state.location}
            onChange={e => setHeadingLocal(+e.target.value)} onPointerUp={saveHeading} onKeyUp={saveHeading} />
          <span style={{ width: '3.2rem', fontVariantNumeric: 'tabular-nums' }}>{Math.round(heading)}° {compassName(heading)}</span>
        </label>
        <button onClick={onClose} title="Close" style={{ marginLeft: 'auto', padding: '0.3rem', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <X size={18} />
        </button>
      </div>

      {/* Map */}
      <div style={{ position: 'relative', flex: 1 }}>
        <div ref={container} style={{ position: 'absolute', inset: 0 }} />

        {!center && (
          <div style={{ position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)', padding: '0.5rem 0.9rem', borderRadius: '20px', background: 'rgba(255,255,255,0.9)', border: '1px solid rgba(79,125,120,0.5)', color: '#dde6ec', fontSize: '0.8rem', fontWeight: 700, pointerEvents: 'none' }}>
            Click an open spot on the map to place your house (zoom in to see buildings)
          </div>
        )}

        {center && siteOccupied && !pending && (
          <div style={{ position: 'absolute', top: '1rem', left: '50%', transform: 'translateX(-50%)', padding: '0.5rem 0.9rem', borderRadius: '20px', background: 'rgba(110,60,52,0.92)', border: '1px solid #b0604f', color: '#7f3f32', fontSize: '0.78rem', fontWeight: 700, pointerEvents: 'none' }}>
            ⚠️ This site overlaps an existing building — click an open area to move the house
          </div>
        )}

        {blocked && (
          <div role="dialog" aria-modal="true" onClick={() => setBlocked(null)}
            style={{ position: 'absolute', inset: 0, zIndex: 5, background: 'rgba(60,52,44,0.175)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
            <div onClick={e => e.stopPropagation()}
              style={{ width: 'min(380px, 100%)', background: '#ffffff', border: '1px solid #b0604f66', borderTop: '3px solid #b0604f', borderRadius: '12px', padding: '1.1rem 1.2rem', boxShadow: '0 20px 50px rgba(60,52,44,0.21)' }}>
              <div style={{ fontSize: '1rem', fontWeight: 800, color: '#2b2926', marginBottom: '0.5rem' }}>🏠 {blocked.title}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{blocked.message}</div>
              <button onClick={() => setBlocked(null)} autoFocus
                style={{ marginTop: '0.9rem', width: '100%', padding: '0.5rem', borderRadius: '8px', border: 'none', background: '#b0604f', color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}>
                Choose another spot
              </button>
            </div>
          </div>
        )}

        {center && (
          <div style={{ position: 'absolute', left: '1rem', top: '1rem', maxWidth: '300px', padding: '0.6rem 0.75rem', borderRadius: '10px', background: 'rgba(255,255,255,0.9)', border: '1px solid var(--border-subtle)', fontSize: '0.72rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <div style={{ color: '#2b2926', fontWeight: 700 }}>
              {busy ? 'Setting site…' : state.location?.address?.split(',').slice(0, 2).join(',') || `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`}
            </div>
            <div>{center.lat.toFixed(5)}° N, {center.lng.toFixed(5)}° E · {state.district.name}</div>
            <div>{floors ? `${floors} floor${floors === 1 ? '' : 's'} · ${heightM.toFixed(1)} m tall` : 'No floors yet — add one to see the house'}</div>
            {note && <div style={{ marginTop: '0.25rem', color: 'var(--text-tertiary)' }}>{note}</div>}
            <div style={{ marginTop: '0.25rem', color: 'var(--text-tertiary)' }}>Click an open spot to move the house · drag to pan · right-drag to tilt and turn</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Surrounding OSM buildings (one feature per building) and the "is this land open?" check ── */
const osmKey = new WeakMap<maplibregl.Map, string>();

function insideRing([x, y]: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const osmOutlines = new WeakMap<maplibregl.Map, [number, number][][]>();

function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** Do two simple polygons overlap (a corner inside the other, or edges crossing)? */
function polygonsOverlap(a: [number, number][], b: [number, number][]): boolean {
  if (a.some(p => insideRing(p, b)) || b.some(p => insideRing(p, a))) return true;
  for (let i = 0; i < a.length - 1; i++)
    for (let j = 0; j < b.length - 1; j++)
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
  return false;
}

/** How many loaded OSM buildings a plot outline overlaps (0 = open land). */
function occupiedBy(map: maplibregl.Map, plot: [number, number][]): number {
  syncOsmBuildings(map, null);
  return (osmOutlines.get(map) ?? []).filter(b => polygonsOverlap(plot, b)).length;
}

/** Copy loaded OSM buildings into 'osm-copy', one feature per building; returns whether `plot` overlaps any. */
function syncOsmBuildings(map: maplibregl.Map, plot: [number, number][] | null): boolean {
  const target = map.getSource('osm-copy') as GeoJSONSource | undefined;
  if (!target) return false;
  const seen = new Set<string>();
  const out: Feature[] = [];
  const outlines: [number, number][][] = [];
  for (const f of map.querySourceFeatures('osm', { sourceLayer: 'building' })) {
    const g = f.geometry;
    if (f.properties?.hide_3d === true || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) continue;
    const props = { h: f.properties?.render_height ?? 6, b: f.properties?.render_min_height ?? 0 };
    // A MultiPolygon here is many buildings merged together — split it back into buildings
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
      const outer = poly[0] as [number, number][];
      const key = `${outer[0][0].toFixed(7)},${outer[0][1].toFixed(7)}:${outer.length}`;  // same building from overlapping tiles
      if (seen.has(key)) continue;
      seen.add(key);
      outlines.push(outer);
      out.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: poly } });
    }
  }
  osmOutlines.set(map, outlines);
  const key = String(out.length);
  if (osmKey.get(map) !== key) {  // only redraw when the set changed — avoids a loop with 'idle'
    osmKey.set(map, key);
    target.setData({ type: 'FeatureCollection', features: out });
  }
  return !!plot && outlines.some(b => polygonsOverlap(plot, b));
}

function compassName(deg: number): string {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}
