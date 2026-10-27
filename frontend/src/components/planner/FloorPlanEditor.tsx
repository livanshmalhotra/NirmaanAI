import { useEffect, useMemo, useRef, useState } from 'react';
import { X, RotateCw, Trash2, MousePointerClick, Move, Trees } from 'lucide-react';
import { useBuilding, type Rect, type Room, type SiteFeature } from '../../context/BuildingContext';
import {
  placeRoom, updateRoom, deleteRoom,
  addSiteFeature, updateSiteFeature, deleteSiteFeature,
} from '../../services/api';
import { ROOM_META, SITE_META, roomMeta, defaultDims, insideUnion, overlaps, MIN_SIDE_FT } from '../../utils/rooms';

type Tab = number | 'site';
type SiteType = 'parking' | 'garden';

/** What the next click on the plan will do. */
type Arm =
  | { kind: 'new-room'; type: string; name: string; w: number; d: number }
  | { kind: 'place-room'; roomId: string; w: number; d: number }
  | { kind: 'new-site'; type: SiteType; w: number; d: number };

interface Drag { id: string; site: boolean; offX: number; offZ: number; rect: Rect; moved: boolean }

const FIELD: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '0.45rem 0.6rem',
  background: 'rgba(60,52,44,0.06)', border: '1px solid var(--border-subtle)',
  borderRadius: '7px', color: '#2b2926', fontSize: '0.8rem',
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-tertiary)', marginBottom: '0.4rem',
};

export function FloorPlanEditor({ onClose, initialFloor }: { onClose: () => void; initialFloor?: number }) {
  const { state, dispatch } = useBuilding();
  const floors = useMemo(() => [...state.floors].sort((a, b) => a.number - b.number), [state.floors]);
  const site = state.site;

  const [tab, setTab] = useState<Tab>(initialFloor ?? (floors[0]?.number ?? 'site'));
  const [arm, setArm] = useState<Arm | null>(null);
  const [hover, setHover] = useState<{ x: number; z: number } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // "Add" form
  const [roomType, setRoomType] = useState('bedroom');
  const [siteType, setSiteType] = useState<SiteType>('parking');
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [width, setWidth] = useState('');

  const svgRef = useRef<SVGSVGElement>(null);

  const floor = typeof tab === 'number' ? floors.find(f => f.number === tab) : undefined;
  const isSite = tab === 'site';

  // Fall back to the site plan if the current floor disappears (e.g. removed via chat)
  useEffect(() => {
    if (typeof tab === 'number' && !floor) setTab(floors[0]?.number ?? 'site');
  }, [tab, floor, floors]);

  const cancel = () => { setArm(null); setError(null); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Escape') { if (arm) cancel(); else onClose(); }
      if ((e.key === 'r' || e.key === 'R') && arm) setArm(a => a && { ...a, w: a.d, d: a.w });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [arm, onClose]);

  /* ── Plan frame (ft) ── */
  const planW = isSite ? site.plot_width_ft : site.base_width_ft;
  const planD = isSite ? site.plot_depth_ft : site.base_depth_ft;
  const buildingOnSite = site.footprint.map(p => ({ ...p, x: p.x + site.building_x, z: p.z + site.building_z }));

  /* ── Area bookkeeping ── */
  const floorUsed = floor ? floor.rooms.reduce((s, r) => s + r.area_sqft, 0) : 0;
  const floorFree = floor ? floor.area_sqft - floorUsed : 0;
  const footprintArea = site.footprint.reduce((s, p) => s + p.w * p.d, 0);
  const featuresArea = site.features.reduce((s, f) => s + f.area_sqft, 0);
  const plotArea = site.plot_width_ft * site.plot_depth_ft;
  const siteFree = plotArea - footprintArea - featuresArea;

  /* ── Requested size from the form ── */
  const areaNum = parseInt(area, 10);
  const widthNum = parseInt(width, 10);
  const dims = (() => {
    if (!areaNum || areaNum <= 0) return null;
    if (widthNum > 0) return { w: widthNum, d: Math.max(1, Math.ceil(areaNum / widthNum)) };
    return defaultDims(areaNum);
  })();
  const formError = (() => {
    if (!dims) return null;
    if (dims.w < MIN_SIDE_FT || dims.d < MIN_SIDE_FT) return `Each side must be at least ${MIN_SIDE_FT} ft.`;
    const actual = dims.w * dims.d;
    if (isSite && actual > siteFree) return `Only ${siteFree} sq ft of open land is left.`;
    if (!isSite && actual > floorFree) return `Floor ${tab} only has ${floorFree} sq ft free.`;
    if (dims.w > planW || dims.d > planD) return `Too large for this ${isSite ? 'plot' : 'floor'} (${planW} × ${planD} ft).`;
    return null;
  })();

  /* ── Placement validity (mirrors backend checks for instant feedback) ── */
  const validRoomRect = (r: Rect, ignoreId?: string) =>
    !!floor && insideUnion(r, floor.footprint) &&
    !floor.rooms.some(o => o.id !== ignoreId && o.x !== null && o.z !== null && overlaps(r, o as Rect));
  const validSiteRect = (r: Rect, ignoreId?: string) =>
    r.x >= 0 && r.z >= 0 && r.x + r.w <= site.plot_width_ft && r.z + r.d <= site.plot_depth_ft &&
    !buildingOnSite.some(p => overlaps(r, p)) &&
    !site.features.some(f => f.id !== ignoreId && overlaps(r, f));

  const clampRect = (x: number, z: number, w: number, d: number): Rect => ({
    x: Math.max(0, Math.min(planW - w, x)),
    z: Math.max(0, Math.min(planD - d, z)),
    w, d,
  });

  const ghost: Rect | null = arm && hover
    ? clampRect(Math.round(hover.x - arm.w / 2), Math.round(hover.z - arm.d / 2), arm.w, arm.d)
    : null;
  const ghostIgnore = arm?.kind === 'place-room' ? arm.roomId : undefined;
  const ghostValid = ghost ? (isSite ? validSiteRect(ghost) : validRoomRect(ghost, ghostIgnore)) : false;

  const toFt = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: p.x, z: p.y };
  };

  const run = async (fn: () => Promise<import('../../context/BuildingContext').BuildingState>) => {
    setBusy(true); setError(null);
    try {
      const next = await fn();
      dispatch({ type: 'SET_STATE', payload: next });
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally { setBusy(false); }
  };

  /* ── Pointer handlers ── */
  const onMove = (e: React.PointerEvent) => {
    const p = toFt(e);
    if (!p) return;
    setHover(p);
    if (drag) {
      const r = clampRect(Math.round(p.x - drag.offX), Math.round(p.z - drag.offZ), drag.rect.w, drag.rect.d);
      if (r.x !== drag.rect.x || r.z !== drag.rect.z) setDrag({ ...drag, rect: r, moved: true });
    }
  };

  const onPlanClick = async () => {
    if (!arm) { setSelected(null); return; }
    if (!ghost || busy) return;
    if (!ghostValid) {
      setError(isSite ? 'That spot overlaps the building or another feature, or leaves the plot.' : 'That spot is outside the floor or overlaps another room.');
      return;
    }
    let ok = false;
    if (arm.kind === 'new-room' && floor) ok = await run(() => placeRoom(floor.number, arm.type, ghost, arm.name));
    if (arm.kind === 'place-room') ok = await run(() => updateRoom(arm.roomId, { rect: ghost }));
    if (arm.kind === 'new-site') ok = await run(() => addSiteFeature(arm.type, ghost, name));
    if (ok) { setArm(null); setName(''); setArea(''); setWidth(''); }
  };

  const startDrag = (e: React.PointerEvent, id: string, rect: Rect, siteItem: boolean) => {
    if (arm) return;
    e.stopPropagation();
    const p = toFt(e);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setSelected(id);
    setDrag({ id, site: siteItem, offX: p.x - rect.x, offZ: p.z - rect.z, rect, moved: false });
  };

  const endDrag = async () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) return;
    const valid = d.site ? validSiteRect(d.rect, d.id) : validRoomRect(d.rect, d.id);
    if (!valid) { setError('Can’t drop it there — it would leave the outline or overlap something.'); return; }
    await run(() => (d.site ? updateSiteFeature(d.id, d.rect) : updateRoom(d.id, { rect: d.rect })));
  };

  /* ── Selection ── */
  const selRoom = floor?.rooms.find(r => r.id === selected);
  const selFeature = isSite ? site.features.find(f => f.id === selected) : undefined;
  const unplaced = floor ? floor.rooms.filter(r => r.x === null || r.z === null) : [];

  const rotateSelected = async () => {
    const item = selRoom ?? selFeature;
    if (!item || item.x === null || item.z === null) return;
    const r: Rect = { x: item.x, z: item.z, w: item.d, d: item.w };
    const valid = selFeature ? validSiteRect(r, item.id) : validRoomRect(r, item.id);
    if (!valid) { setError('Not enough space to rotate it in place — drag it somewhere roomier first.'); return; }
    await run(() => (selFeature ? updateSiteFeature(item.id, r) : updateRoom(item.id, { rect: r })));
  };

  const deleteSelected = async () => {
    if (selRoom && await run(() => deleteRoom(selRoom.id))) setSelected(null);
    if (selFeature && await run(() => deleteSiteFeature(selFeature.id))) setSelected(null);
  };

  const armFromForm = () => {
    if (!dims || formError) return;
    setSelected(null); setError(null);
    if (isSite) setArm({ kind: 'new-site', type: siteType, ...dims });
    else setArm({ kind: 'new-room', type: roomType, name: name.trim(), ...dims });
  };

  /* ── Render helpers ── */
  const roomRects = (floor?.rooms ?? []).filter(r => r.x !== null && r.z !== null)
    .map(r => (drag && drag.id === r.id ? { room: r, rect: drag.rect } : { room: r, rect: { x: r.x!, z: r.z!, w: r.w, d: r.d } }));
  const featureRects = site.features
    .map(f => (drag && drag.id === f.id ? { f, rect: drag.rect } : { f, rect: f as Rect }));

  const label = (rect: Rect, title: string, sub: string, color: string) => fitLabel(rect, title, sub, color);

  const typeOptions = isSite
    ? (Object.keys(SITE_META) as SiteType[]).map(t => ({ id: t, ...SITE_META[t] }))
    : Object.entries(ROOM_META).map(([id, m]) => ({ id, ...m }));
  const currentType = isSite ? siteType : roomType;
  const suggested = (isSite ? SITE_META[siteType] : roomMeta(roomType)).suggestedSqft;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 900, background: 'rgba(60,52,44,0.227)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{
        width: 'min(1200px, 94vw)', height: 'min(800px, 90vh)', display: 'flex', overflow: 'hidden',
        background: '#fbfaf7', border: '1px solid var(--border-subtle)', borderRadius: '16px', boxShadow: '0 20px 60px rgba(60,52,44,0.175)',
      }}>
        {/* ── Sidebar ── */}
        <div style={{ width: '290px', flexShrink: 0, borderRight: '1px solid var(--border-subtle)', overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#2b2926' }}>Floor Plan</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
              You decide the size and position of every room.
            </div>
          </div>

          {/* Stats */}
          {isSite ? (
            <AreaBar label="OPEN LAND" used={footprintArea + featuresArea} total={plotArea}
              detail={`Plot ${plotArea} · Building ${footprintArea} · Parking/garden ${featuresArea} · Free ${siteFree} sq ft`} />
          ) : floor ? (
            <AreaBar label={`FLOOR ${floor.number} AREA`} used={floorUsed} total={floor.area_sqft}
              detail={`${floorUsed} of ${floor.area_sqft} sq ft used · ${floorFree} sq ft free`} />
          ) : null}

          {/* Add form */}
          {(isSite || floor) && (
            <div>
              <div style={SECTION_LABEL}>{isSite ? 'ADD TO PLOT' : 'ADD A ROOM'}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.3rem', marginBottom: '0.6rem' }}>
                {typeOptions.map(t => {
                  const active = t.id === currentType;
                  return (
                    <button key={t.id} type="button"
                      onClick={() => (isSite ? setSiteType(t.id as SiteType) : setRoomType(t.id))}
                      style={{
                        padding: '0.35rem 0.2rem', borderRadius: '7px', cursor: 'pointer', fontSize: '0.62rem', fontWeight: 600,
                        background: active ? `${t.color}26` : 'rgba(60,52,44,0.036)',
                        border: `1px solid ${active ? t.color : 'var(--border-subtle)'}`,
                        color: active ? t.color : 'var(--text-secondary)',
                        textTransform: 'capitalize',
                      }}>
                      {t.symbol} {t.id}
                    </button>
                  );
                })}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                <input style={FIELD} placeholder={`Name (optional, e.g. "Master ${isSite ? siteType : roomType}")`} value={name} onChange={e => setName(e.target.value)} />
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem' }}>
                  <label style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>
                    AREA (SQ FT) *
                    <input style={{ ...FIELD, marginTop: '0.2rem' }} type="number" min={16} placeholder={`e.g. ${suggested}`} value={area} onChange={e => setArea(e.target.value)} />
                  </label>
                  <label style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)' }}>
                    WIDTH (FT)
                    <input style={{ ...FIELD, marginTop: '0.2rem' }} type="number" min={MIN_SIDE_FT} placeholder={dims ? String(dims.w) : 'auto'} value={width} onChange={e => setWidth(e.target.value)} />
                  </label>
                </div>
                <div style={{ fontSize: '0.66rem', color: formError ? '#9a5040' : 'var(--text-tertiary)', minHeight: '1em' }}>
                  {formError ?? (dims ? `→ ${dims.w} × ${dims.d} ft = ${dims.w * dims.d} sq ft` : 'Enter how many sq ft you need.')}
                </div>
                <button type="button" onClick={armFromForm} disabled={!dims || !!formError || busy}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                    padding: '0.55rem', borderRadius: '8px', border: 'none', fontWeight: 700, fontSize: '0.78rem',
                    background: !dims || formError ? 'rgba(60,52,44,0.072)' : '#5d6b80',
                    color: !dims || formError ? 'var(--text-tertiary)' : '#fff',
                    cursor: !dims || formError ? 'not-allowed' : 'pointer',
                  }}>
                  <MousePointerClick size={14} /> Pick the spot on the plan
                </button>
              </div>
            </div>
          )}

          {/* Rooms added via chat that still need a spot */}
          {unplaced.length > 0 && (
            <div>
              <div style={{ ...SECTION_LABEL, color: '#8c6a2f' }}>WAITING FOR A SPOT ({unplaced.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {unplaced.map(r => (
                  <UnplacedRow key={r.id} room={r} active={arm?.kind === 'place-room' && arm.roomId === r.id}
                    onPlace={() => { setSelected(null); setArm({ kind: 'place-room', roomId: r.id, w: r.w, d: r.d }); }}
                    onDelete={() => run(() => deleteRoom(r.id))} />
                ))}
              </div>
            </div>
          )}

          {/* Selection */}
          {(selRoom || selFeature) && !arm && (
            <div style={{ border: '1px solid var(--border-subtle)', borderRadius: '10px', padding: '0.65rem' }}>
              <div style={SECTION_LABEL}>SELECTED</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#2b2926' }}>{(selRoom ?? selFeature)!.name}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', margin: '0.2rem 0 0.55rem' }}>
                {(selRoom ?? selFeature)!.w} × {(selRoom ?? selFeature)!.d} ft · {(selRoom ?? selFeature)!.area_sqft} sq ft · drag to move
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <SmallBtn onClick={rotateSelected} disabled={busy}><RotateCw size={12} /> Rotate</SmallBtn>
                <SmallBtn onClick={deleteSelected} disabled={busy} danger><Trash2 size={12} /> Remove</SmallBtn>
              </div>
            </div>
          )}

          <div style={{ marginTop: 'auto', fontSize: '0.62rem', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
            <Move size={10} style={{ verticalAlign: 'middle' }} /> Drag rooms to move them · <b>R</b> rotates while placing · <b>Esc</b> cancels
          </div>
        </div>

        {/* ── Plan ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Tabs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.6rem 0.8rem', borderBottom: '1px solid var(--border-subtle)', overflowX: 'auto' }}>
            <TabBtn active={isSite} onClick={() => { setTab('site'); cancel(); setSelected(null); }}>
              <Trees size={12} /> Site · Parking & Garden
            </TabBtn>
            {floors.map(f => {
              const pending = f.rooms.some(r => r.x === null);
              return (
                <TabBtn key={f.id} active={tab === f.number} onClick={() => { setTab(f.number); cancel(); setSelected(null); }}>
                  Floor {f.number}{pending && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#8c6a2f' }} />}
                </TabBtn>
              );
            })}
            {floors.length === 0 && <span style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)', marginLeft: '0.5rem' }}>Add a floor first to place rooms.</span>}
            <button onClick={onClose} title="Close" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem' }}>
              <X size={18} />
            </button>
          </div>

          {/* Status line */}
          <div style={{ padding: '0.45rem 0.9rem', fontSize: '0.72rem', minHeight: '1.2rem', color: error ? '#9a5040' : arm ? '#4f7d78' : 'var(--text-tertiary)' }}>
            {error ?? (arm
              ? `Click where the ${arm.kind === 'new-site' ? arm.type : 'room'} (${arm.w} × ${arm.d} ft) should go. Green = fits, red = blocked. R rotates, Esc cancels.`
              : isSite ? 'Plot plan — the hatched area is the building. Place parking and gardens on the open land.'
              : 'Top-down view of this floor. Front of the building (road side) is at the bottom.')}
          </div>

          <div style={{ flex: 1, padding: '0.5rem 1rem 1rem', minHeight: 0 }}>
            {planW > 0 && planD > 0 && (isSite || floor) && (
              <svg
                ref={svgRef}
                viewBox={`-2 -2 ${planW + 4} ${planD + 6}`}
                style={{ width: '100%', height: '100%', cursor: arm ? (ghostValid ? 'copy' : 'not-allowed') : drag ? 'grabbing' : 'default', touchAction: 'none' }}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
                onPointerUp={endDrag}
                onClick={onPlanClick}
              >
                <defs>
                  <pattern id="grid1" width="1" height="1" patternUnits="userSpaceOnUse">
                    <path d="M1 0H0V1" fill="none" stroke="rgba(60,52,44,0.06)" strokeWidth="0.05" />
                  </pattern>
                  <pattern id="grid5" width="5" height="5" patternUnits="userSpaceOnUse">
                    <rect width="5" height="5" fill="url(#grid1)" />
                    <path d="M5 0H0V5" fill="none" stroke="rgba(60,52,44,0.144)" strokeWidth="0.08" />
                  </pattern>
                  <pattern id="hatch" width="1.5" height="1.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <rect width="1.5" height="1.5" fill="rgba(107,102,94,0.12)" />
                    <line x1="0" y1="0" x2="0" y2="1.5" stroke="rgba(107,102,94,0.45)" strokeWidth="0.3" />
                  </pattern>
                </defs>

                {isSite ? (
                  <>
                    <rect x={0} y={0} width={planW} height={planD} fill="rgba(74,124,58,0.18)" stroke="rgba(60,52,44,0.45)" strokeWidth="0.25" strokeDasharray="1 0.6" />
                    <rect x={0} y={0} width={planW} height={planD} fill="url(#grid5)" pointerEvents="none" />
                    {buildingOnSite.map((p, i) => (
                      <rect key={i} x={p.x} y={p.z} width={p.w} height={p.d} fill="url(#hatch)" stroke="#6b665e" strokeWidth="0.2" />
                    ))}
                    {buildingOnSite.length > 0 && label(
                      { x: site.building_x, z: site.building_z, w: site.base_width_ft, d: site.base_depth_ft },
                      'BUILDING', `${footprintArea} sq ft`, '#6b665e',
                    )}
                    {featureRects.map(({ f, rect }) => (
                      <FeatureShape key={f.id} f={f} rect={rect} selected={selected === f.id} armed={!!arm}
                        onPointerDown={e => startDrag(e, f.id, rect, true)} label={label} />
                    ))}
                  </>
                ) : floor && (
                  <>
                    {floor.footprint.map((p, i) => (
                      <rect key={i} x={p.x} y={p.z} width={p.w} height={p.d} fill="rgba(61,58,53,0.06)" />
                    ))}
                    {floor.footprint.map((p, i) => (
                      <rect key={`g${i}`} x={p.x} y={p.z} width={p.w} height={p.d} fill="url(#grid5)" pointerEvents="none" />
                    ))}
                    <Outline parts={floor.footprint} />
                    {roomRects.map(({ room, rect }) => {
                      const m = roomMeta(room.type);
                      const sel = selected === room.id;
                      return (
                        <g key={room.id} onPointerDown={e => startDrag(e, room.id, rect, false)} onClick={e => { if (!arm) e.stopPropagation(); }}
                          style={{ cursor: arm ? undefined : 'grab' }}>
                          <rect x={rect.x + 0.15} y={rect.z + 0.15} width={rect.w - 0.3} height={rect.d - 0.3} rx="0.4"
                            fill={`${m.color}33`} stroke={sel ? '#fff' : m.color} strokeWidth={sel ? 0.35 : 0.2} />
                          {label(rect, `${m.symbol} ${room.name}`, `${rect.w}×${rect.d} ft · ${rect.w * rect.d} sq ft`, m.color)}
                        </g>
                      );
                    })}
                  </>
                )}

                {/* Ghost of the thing being placed */}
                {ghost && (
                  <rect x={ghost.x} y={ghost.z} width={ghost.w} height={ghost.d} rx="0.4" pointerEvents="none"
                    fill={ghostValid ? 'rgba(92,125,89,0.28)' : 'rgba(176,96,79,0.28)'}
                    stroke={ghostValid ? '#5c7d59' : '#b0604f'} strokeWidth="0.3" strokeDasharray="0.8 0.4" />
                )}

                {/* Dimensions + road side marker */}
                <text x={planW / 2} y={planD + 2.6} textAnchor="middle" fontSize="1.4" fill="var(--text-tertiary)">
                  ← {planW} ft → {isSite ? '· ROAD SIDE' : '· FRONT'}
                </text>
                <text x={-1} y={planD / 2} textAnchor="middle" fontSize="1.4" fill="var(--text-tertiary)" transform={`rotate(-90 -1 ${planD / 2})`}>
                  {planD} ft
                </text>
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Pieces ── */

function AreaBar({ label, used, total, detail }: { label: string; used: number; total: number; detail: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div>
      <div style={SECTION_LABEL}>{label}</div>
      <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(60,52,44,0.072)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pct > 95 ? '#b0604f' : 'linear-gradient(90deg, #7d8aa3, #8fa9a2)', transition: 'width 0.3s' }} />
      </div>
      <div style={{ fontSize: '0.66rem', color: 'var(--text-secondary)', marginTop: '0.35rem', lineHeight: 1.5 }}>{detail}</div>
    </div>
  );
}

/** Exterior outline of a union of rects, drawn as 1-ft edge segments. */
function Outline({ parts }: { parts: Rect[] }) {
  const inside = (x: number, z: number) => parts.some(p => p.x <= x && x < p.x + p.w && p.z <= z && z < p.z + p.d);
  const segs: string[] = [];
  for (const p of parts) {
    for (let x = p.x; x < p.x + p.w; x++) {
      if (!inside(x, p.z - 1)) segs.push(`M${x} ${p.z}h1`);
      if (!inside(x, p.z + p.d)) segs.push(`M${x} ${p.z + p.d}h1`);
    }
    for (let z = p.z; z < p.z + p.d; z++) {
      if (!inside(p.x - 1, z)) segs.push(`M${p.x} ${z}v1`);
      if (!inside(p.x + p.w, z)) segs.push(`M${p.x + p.w} ${z}v1`);
    }
  }
  return <path d={segs.join('')} stroke="#8f897f" strokeWidth="0.45" strokeLinecap="square" fill="none" pointerEvents="none" />;
}

/* Average glyph width of the plan font, as a fraction of the font size (bold sans, emoji ≈ 1.2) */
const GLYPH = 0.62;
const textWidth = (s: string, fs: number) => Array.from(s).reduce((w, ch) => w + (ch.codePointAt(0)! > 0x2000 ? 1.2 : GLYPH), 0) * fs;

/**
 * Room / feature name and size, sized to fit inside its rectangle (plan units
 * are feet). Long names in small rooms are shortened with "…", the size line is
 * dropped when there's no room for it, and everything is clipped to the box.
 */
function fitLabel(rect: Rect, title: string, sub: string, color: string) {
  const pad = Math.min(0.8, rect.w * 0.08);
  const w = rect.w - 2 * pad, h = rect.d - 2 * pad;
  const MIN = 0.7, MAX = 1.6;
  let fs = Math.min(MAX, (w / textWidth(title, 1)), h / 2.4);
  let shown = title;
  if (fs < MIN) {
    fs = Math.max(0.45, Math.min(MIN, h / 1.3));
    while (shown.length > 2 && textWidth(shown + '…', fs) > w) shown = Array.from(shown).slice(0, -1).join('');
    if (shown !== title) shown = shown.trimEnd() + '…';
  }
  let subFs = Math.min(fs * 0.78, w / textWidth(sub, 1));
  const showSub = subFs >= 0.45 && fs * 1.15 + subFs * 1.2 <= h;
  if (!showSub) subFs = 0;
  const block = fs + (showSub ? 0.3 * fs + subFs : 0);
  const titleY = rect.d / 2 - block / 2 + fs * 0.82;
  return (
    <svg x={rect.x} y={rect.z} width={rect.w} height={rect.d} overflow="hidden" pointerEvents="none">
      <title>{`${title} — ${sub}`}</title>
      <text x={rect.w / 2} y={titleY} textAnchor="middle" fontSize={fs} fontWeight={700} fill="#2b2926">{shown}</text>
      {showSub && (
        <text x={rect.w / 2} y={titleY + 0.3 * fs + subFs * 0.95} textAnchor="middle" fontSize={subFs} fontWeight={600} fill={color}>{sub}</text>
      )}
    </svg>
  );
}

function FeatureShape({ f, rect, selected, armed, onPointerDown, label }: {
  f: SiteFeature; rect: Rect; selected: boolean; armed: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  label: (r: Rect, t: string, s: string, c: string) => React.ReactNode;
}) {
  const m = SITE_META[f.type];
  const stalls = f.type === 'parking' ? Math.floor((rect.w >= rect.d ? rect.w : rect.d) / 9) : 0;
  return (
    <g onPointerDown={onPointerDown} onClick={e => { if (!armed) e.stopPropagation(); }} style={{ cursor: armed ? undefined : 'grab' }}>
      <rect x={rect.x} y={rect.z} width={rect.w} height={rect.d} rx="0.3"
        fill={f.type === 'parking' ? 'rgba(75,85,99,0.75)' : 'rgba(92,125,89,0.35)'}
        stroke={selected ? '#fff' : m.color} strokeWidth={selected ? 0.35 : 0.2} />
      {Array.from({ length: Math.max(0, stalls - 1) }, (_, i) => (rect.w >= rect.d
        ? <line key={i} x1={rect.x + (i + 1) * 9} y1={rect.z} x2={rect.x + (i + 1) * 9} y2={rect.z + rect.d * 0.6} stroke="#3d3a35" strokeWidth="0.15" pointerEvents="none" />
        : <line key={i} x1={rect.x} y1={rect.z + (i + 1) * 9} x2={rect.x + rect.w * 0.6} y2={rect.z + (i + 1) * 9} stroke="#3d3a35" strokeWidth="0.15" pointerEvents="none" />
      ))}
      {label(rect, `${m.symbol} ${f.name}`, `${rect.w}×${rect.d} ft · ${rect.w * rect.d} sq ft`, m.color)}
    </g>
  );
}

function UnplacedRow({ room, active, onPlace, onDelete }: { room: Room; active: boolean; onPlace: () => void; onDelete: () => void }) {
  const m = roomMeta(room.type);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.5rem', borderRadius: '8px',
      border: `1px solid ${active ? '#4f7d78' : 'var(--border-subtle)'}`, background: 'rgba(165,124,58,0.05)',
    }}>
      <span style={{ fontSize: '0.75rem' }}>{m.symbol}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#3d3a35', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{room.name}</div>
        <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{room.area_sqft} sq ft · {room.w}×{room.d} ft</div>
      </div>
      <SmallBtn onClick={onPlace}>Place</SmallBtn>
      <button onClick={onDelete} title="Remove" style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0 }}><Trash2 size={12} /></button>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: '0.35rem', whiteSpace: 'nowrap',
      padding: '0.35rem 0.7rem', borderRadius: '8px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
      background: active ? 'rgba(79,125,120,0.15)' : 'transparent',
      border: `1px solid ${active ? 'rgba(79,125,120,0.4)' : 'var(--border-subtle)'}`,
      color: active ? '#4f7d78' : 'var(--text-secondary)',
    }}>{children}</button>
  );
}

function SmallBtn({ onClick, disabled, danger, children }: { onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.55rem', borderRadius: '6px',
      fontSize: '0.66rem', fontWeight: 600, cursor: disabled ? 'wait' : 'pointer',
      background: danger ? 'rgba(176,96,79,0.1)' : 'rgba(60,52,44,0.072)',
      border: `1px solid ${danger ? 'rgba(176,96,79,0.35)' : 'var(--border-subtle)'}`,
      color: danger ? '#9a5040' : 'var(--text-secondary)',
    }}>{children}</button>
  );
}

