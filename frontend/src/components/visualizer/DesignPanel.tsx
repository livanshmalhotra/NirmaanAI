import { useEffect, useState } from 'react';
import { MousePointerClick, X, Trash2, RotateCw, Move, Eye } from 'lucide-react';
import { useBuilding, type BuildingState, type Floor, type Room, type WallSide, type WindowSpec } from '../../context/BuildingContext';
import { useDesign } from '../../context/DesignContext';
import { deleteFloor, deleteRoom, setFloorShape, setRoomWindows, setWalls, updateRoom } from '../../services/api';
import { ROOM_META, roomMeta, defaultDims, MIN_SIDE_FT, insideUnion, overlaps } from '../../utils/rooms';
import { SHAPES } from '../../utils/shapes';
import { PRESETS, sizeChoices } from '../../utils/presets';
import { suggestWalls, suggestedGlazingSqft, exteriorLength, suggestedWindows, userWindows, WALL_OPTIONS_IN, inchToMm } from '../../utils/walls';

type Tab = 'room' | 'windows' | 'walls' | 'shapes';
const SIDES: WallSide[] = ['front', 'back', 'left', 'right'];

const FIELD: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '0.45rem 0.55rem',
  background: 'rgba(60,52,44,0.072)', border: '1px solid var(--border-subtle)',
  borderRadius: '7px', color: '#2b2926', fontSize: '0.8rem',
};
const LABEL: React.CSSProperties = { fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)' };
const HINT: React.CSSProperties = { fontSize: '0.66rem', color: 'var(--text-tertiary)', lineHeight: 1.45 };
const ICON_BTN: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px', flexShrink: 0,
  borderRadius: '6px', border: '1px solid var(--border-subtle)', background: 'rgba(60,52,44,0.048)',
  color: 'var(--text-secondary)', cursor: 'pointer', padding: 0,
};

const isPlaced = (r: Room): r is Room & { x: number; z: number } => r.x !== null && r.z !== null;

/** Docked design controls on the left of the workspace. */
export function DesignPanel() {
  const { state, dispatch } = useBuilding();
  const { placing, setPlacing, focusFloor, setFocusFloor, notice, setNotice, pulseWalls } = useDesign();
  const floors = [...state.floors].sort((a, b) => a.number - b.number);
  const [tab, setTab] = useState<Tab>('room');
  const [busy, setBusy] = useState(false);

  const floor = floors.find(f => f.number === focusFloor) ?? floors[0];
  // Keep the 3D focus in sync with the floor being edited
  useEffect(() => {
    // A removed floor can't stay selected
    if (focusFloor !== null && !floors.some(f => f.number === focusFloor)) setFocusFloor(floors[0]?.number ?? null);
  }, [floors, focusFloor, setFocusFloor]);

  const run = async (fn: () => Promise<BuildingState>, ok: string) => {
    setBusy(true); setNotice(null);
    try {
      dispatch({ type: 'SET_STATE', payload: await fn() });
      setNotice({ text: ok, error: false });
      return true;
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      return false;
    } finally { setBusy(false); }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: '0.25rem', padding: '0.75rem 0.85rem 0.6rem' }}>
        {([['room', 'Rooms'], ['windows', 'Windows'], ['walls', 'Walls'], ['shapes', 'Shapes']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} onClick={() => {
            setTab(id); setNotice(null); setPlacing(null);
            // Shapes and walls are about the whole building
            if (id === 'shapes' || id === 'walls') setFocusFloor(null);
          }} style={{
            flex: 1, padding: '0.4rem 0', borderRadius: '7px', fontSize: '0.7rem', fontWeight: 700, cursor: 'pointer',
            background: tab === id ? 'rgba(79,125,120,0.15)' : 'transparent',
            border: `1px solid ${tab === id ? 'rgba(79,125,120,0.4)' : 'var(--border-subtle)'}`,
            color: tab === id ? '#4f7d78' : 'var(--text-secondary)',
          }}>{label}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        {floors.length === 0 && tab !== 'walls' ? (
          <div style={HINT}>Add a floor first (3D toolbar → <b>Add Floor</b>), then design its rooms here.</div>
        ) : (
          <>
            {(tab === 'room' || tab === 'windows') && floor && (
              <FloorPicker floors={floors} value={floor.number} onChange={n => { setFocusFloor(n); setPlacing(null); }} />
            )}
            {tab === 'room' && floor && (
              <button disabled={busy} title={`Remove Floor ${floor.number} and its ${floor.rooms.length} room(s); floors above move down`}
                onClick={() => {
                  const what = `Delete Floor ${floor.number}${floor.rooms.length ? ` and its ${floor.rooms.length} room(s)` : ''}?`
                    + (floor.number < floors.length ? ' Floors above it move down one level.' : '');
                  if (window.confirm(what)) {
                    setPlacing(null);
                    run(() => deleteFloor(floor.number), `Floor ${floor.number} deleted.`);
                  }
                }}
                style={{ ...FIELD, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', cursor: 'pointer',
                  fontSize: '0.72rem', fontWeight: 700, color: '#7f3f32', borderColor: 'rgba(154,80,64,0.35)', background: 'rgba(154,80,64,0.06)' }}>
                <Trash2 size={13} /> Delete Floor {floor.number}
              </button>
            )}
            {tab === 'room' && floor && (
              <RoomTab floor={floor} busy={busy} run={run} />
            )}
            {tab === 'windows' && floor && (
              <WindowsTab floor={floor} busy={busy}
                onSave={(room, spec) => run(() => setRoomWindows(room.id, spec),
                  spec.count ? `${room.name}: ${spec.count} window(s) on the ${spec.side} wall.` : `${room.name}: no windows on the ${spec.side} wall.`)} />
            )}
            {tab === 'walls' && <WallsTab key={`${state.constraints.exteriorWallIn}-${state.constraints.interiorWallIn}`} state={state} busy={busy}
              onSave={async (e, i) => { if (await run(() => setWalls(e, i), `Walls set to ${e}″ outside / ${i}″ inside — highlighted in 3D.`)) pulseWalls(); }} />}
            {tab === 'shapes' && <ShapesTab floors={floors} busy={busy}
              onSet={(n, shape) => run(() => setFloorShape(n, shape), `Floor ${n} is now ${shape}.`)} />}
          </>
        )}
        {notice && !placing && (
          <div style={{
            fontSize: '0.7rem', lineHeight: 1.45, padding: '0.45rem 0.55rem', borderRadius: '8px',
            color: notice.error ? '#9a5040' : '#4c6b49',
            background: notice.error ? 'rgba(154,80,64,0.08)' : 'rgba(76,107,73,0.08)',
          }}>{notice.text}</div>
        )}
      </div>
    </div>
  );
}

function FloorPicker({ floors, value, onChange }: { floors: Floor[]; value?: number; onChange: (n: number) => void }) {
  return (
    <div>
      <div style={{ ...LABEL, display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        FLOOR <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>· floors above are hidden in 3D</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginTop: '0.3rem' }}>
        {floors.map(f => (
          <button key={f.id} onClick={() => onChange(f.number)} style={{
            padding: '0.3rem 0.65rem', borderRadius: '6px', fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer',
            background: value === f.number ? 'rgba(110,104,144,0.25)' : 'rgba(60,52,44,0.048)',
            border: `1px solid ${value === f.number ? '#6e6890' : 'var(--border-subtle)'}`,
            color: value === f.number ? '#4f4a6e' : 'var(--text-secondary)',
          }}>Floor {f.number}</button>
        ))}
      </div>
    </div>
  );
}

/* ── Rooms: size it, place it in 3D, see every room on the floor ── */
function RoomTab({ floor, busy, run }: {
  floor: Floor; busy: boolean; run: (fn: () => Promise<BuildingState>, ok: string) => Promise<boolean>;
}) {
  const { placing, setPlacing, notice, setNotice, openPreset } = useDesign();
  const [type, setType] = useState('bedroom');
  const [name, setName] = useState('');
  const [area, setArea] = useState('');
  const [width, setWidth] = useState('');

  const used = floor.rooms.reduce((s, r) => s + r.area_sqft, 0);
  const free = floor.area_sqft - used;
  const areaNum = parseInt(area, 10);
  const widthNum = parseInt(width, 10);
  const dims = areaNum > 0 ? (widthNum > 0 ? { w: widthNum, d: Math.max(1, Math.ceil(areaNum / widthNum)) } : defaultDims(areaNum)) : null;
  const error = !dims ? null
    : dims.w < MIN_SIDE_FT || dims.d < MIN_SIDE_FT ? `Each side must be at least ${MIN_SIDE_FT} ft.`
    : dims.w * dims.d > free ? `Floor ${floor.number} only has ${free} sq ft free.`
    : null;

  /** Rotate a placed room in place, refusing if it would leave the floor or touch into another room. */
  const rotate = (r: Room) => {
    if (!isPlaced(r)) return;
    const rect = { x: r.x, z: r.z, w: r.d, d: r.w };
    if (!insideUnion(rect, floor.footprint)) {
      setNotice({ text: `${r.name} can't turn here — it would stick out of the floor. Use Move to find a spot.`, error: true });
      return;
    }
    const clash = floor.rooms.find(o => o.id !== r.id && isPlaced(o) && overlaps(rect, o as Room & { x: number; z: number }));
    if (clash) {
      setNotice({ text: `${r.name} can't turn here — it would overlap ${clash.name}. Use Move to find a spot.`, error: true });
      return;
    }
    run(() => updateRoom(r.id, { rect }), `${r.name} rotated to ${rect.w} × ${rect.d} ft.`);
  };

  if (placing) {
    return (
      <div style={{ border: '1px solid rgba(79,125,120,0.4)', background: 'rgba(79,125,120,0.08)', borderRadius: '10px', padding: '0.7rem' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 700, color: '#4f7d78', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <MousePointerClick size={15} /> Click in the 3D view where it goes
        </div>
        <div style={{ ...HINT, marginTop: '0.4rem' }}>
          <b style={{ color: '#3d3a35' }}>{placing.name || placing.type}</b> · {placing.w} × {placing.d} ft on Floor {placing.floor}.
          The box turns <b style={{ color: '#4c6b49' }}>green</b> where it fits and <b style={{ color: '#9a5040' }}>red</b> where it would
          leave the floor or overlap another room. Drag to orbit the view.
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.55rem' }}>
          <button onClick={() => setPlacing(p => p && { ...p, w: p.d, d: p.w })} style={{ ...FIELD, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}>
            <RotateCw size={13} /> Rotate (R)
          </button>
          <button onClick={() => setPlacing(null)} style={{ ...FIELD, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem' }}>
            <X size={13} /> Cancel (Esc)
          </button>
        </div>
        {notice?.error && <div style={{ fontSize: '0.68rem', color: '#9a5040', marginTop: '0.45rem' }}>{notice.text}</div>}
      </div>
    );
  }

  return (
    <>
      {/* Area meter */}
      <div>
        <div style={{ height: '6px', borderRadius: '3px', background: 'rgba(60,52,44,0.072)', overflow: 'hidden' }}>
          <div style={{ width: `${Math.min(100, (used / Math.max(floor.area_sqft, 1)) * 100)}%`, height: '100%', background: 'linear-gradient(90deg, #7d8aa3, #8fa9a2)' }} />
        </div>
        <div style={{ ...HINT, marginTop: '0.3rem' }}>{used} of {floor.area_sqft} sq ft used · <b style={{ color: free > 0 ? '#4c6b49' : '#9a5040' }}>{free} sq ft free</b></div>
      </div>

      {/* Whole-home presets — the dialog asks which floor and suggests sizes */}
      <div>
        <div style={LABEL}>QUICK START · ADD A WHOLE HOME</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.25rem', marginTop: '0.3rem' }}>
          {PRESETS.map(p => (
            <button key={p.id} title={p.desc} onClick={() => openPreset(p)} style={{
              padding: '0.35rem 0.2rem', borderRadius: '6px', fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer',
              background: `${p.color}14`, border: `1px solid ${p.color}55`, color: p.color,
            }}>{p.emoji} {p.label}</button>
          ))}
        </div>
      </div>

      {/* Rooms on this floor */}
      <div>
        <div style={LABEL}>ROOMS ON FLOOR {floor.number} ({floor.rooms.length})</div>
        {floor.rooms.length === 0 && <div style={{ ...HINT, marginTop: '0.3rem' }}>No rooms yet — add one below.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.35rem' }}>
          {floor.rooms.map(r => {
            const m = roomMeta(r.type);
            const placed = r.x !== null && r.z !== null;
            return (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: '0.45rem', padding: '0.4rem 0.5rem', borderRadius: '8px',
                background: `${m.color}12`, border: `1px solid ${placed ? `${m.color}55` : 'rgba(165,124,58,0.5)'}`,
              }}>
                <span style={{ width: '22px', height: '22px', borderRadius: '5px', background: `${m.color}30`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', flexShrink: 0 }}>{m.symbol}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.76rem', fontWeight: 700, color: '#2b2926', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
                  <div style={{ fontSize: '0.62rem', color: placed ? 'var(--text-tertiary)' : '#8c6a2f' }}>
                    {r.w} × {r.d} ft · {r.area_sqft} sq ft{placed ? ` · at ${r.x}, ${r.z}` : ' · not placed'}
                  </div>
                </div>
                {placed ? (
                  <>
                    <button title="Move in 3D" disabled={busy} style={ICON_BTN}
                      onClick={() => { setNotice(null); setPlacing({ kind: 'existing', floor: floor.number, roomId: r.id, type: r.type, name: r.name, w: r.w, d: r.d }); }}>
                      <Move size={12} />
                    </button>
                    <button title="Rotate 90°" disabled={busy} style={ICON_BTN} onClick={() => rotate(r)}><RotateCw size={12} /></button>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => { setNotice(null); setPlacing({ kind: 'existing', floor: floor.number, roomId: r.id, type: r.type, name: r.name, w: r.w, d: r.d }); }}
                    style={{ ...ICON_BTN, width: 'auto', padding: '0 0.5rem', fontSize: '0.64rem', fontWeight: 700, color: '#8c6a2f', borderColor: 'rgba(165,124,58,0.5)' }}>
                    Place
                  </button>
                )}
                <button title="Remove" disabled={busy} style={ICON_BTN} onClick={() => run(() => deleteRoom(r.id), `${r.name} removed.`)}><Trash2 size={12} /></button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add a room */}
      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={LABEL}>ADD A ROOM</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.25rem' }}>
          {Object.entries(ROOM_META).map(([id, m]) => (
            <button key={id} onClick={() => setType(id)} style={{
              padding: '0.35rem 0.1rem', borderRadius: '6px', fontSize: '0.64rem', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
              background: type === id ? `${m.color}26` : 'rgba(60,52,44,0.036)',
              border: `1px solid ${type === id ? m.color : 'var(--border-subtle)'}`,
              color: type === id ? m.color : 'var(--text-secondary)',
            }}>{m.symbol} {id}</button>
          ))}
        </div>
        <label style={LABEL}>
          HOW MANY SQ FT? *
          <input style={{ ...FIELD, marginTop: '0.25rem', fontSize: '1rem', fontWeight: 700, borderColor: area ? 'var(--border-subtle)' : 'rgba(79,125,120,0.5)' }}
            type="number" inputMode="numeric" min={16} placeholder={`e.g. ${roomMeta(type).suggestedSqft}`}
            value={area} onChange={e => setArea(e.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {sizeChoices(type).map(c => (
            <button key={c.label} onClick={() => setArea(String(c.sqft))} style={{
              flex: 1, padding: '0.3rem 0.2rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.64rem', fontWeight: 700,
              background: area === String(c.sqft) ? 'rgba(79,125,120,0.18)' : 'rgba(60,52,44,0.036)',
              border: `1px solid ${area === String(c.sqft) ? 'rgba(79,125,120,0.5)' : 'var(--border-subtle)'}`,
              color: c.sqft > free ? 'var(--text-tertiary)' : area === String(c.sqft) ? '#4f7d78' : 'var(--text-secondary)',
            }}>{c.label}<br /><span style={{ fontWeight: 500 }}>{c.sqft} sq ft</span></button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
          <label style={LABEL}>
            WIDTH (FT)
            <input style={{ ...FIELD, marginTop: '0.25rem' }} type="number" min={MIN_SIDE_FT}
              placeholder={dims ? String(dims.w) : 'auto'} value={width} onChange={e => setWidth(e.target.value)} />
          </label>
          <label style={LABEL}>
            NAME
            <input style={{ ...FIELD, marginTop: '0.25rem' }} placeholder={`${type[0].toUpperCase() + type.slice(1)} ${floor.rooms.filter(r => r.type === type).length + 1}`} value={name} onChange={e => setName(e.target.value)} />
          </label>
        </div>
        <div style={{ fontSize: '0.68rem', color: error ? '#9a5040' : 'var(--text-tertiary)' }}>
          {error ?? (dims ? `→ ${dims.w} × ${dims.d} ft = ${dims.w * dims.d} sq ft` : 'Type the size, then pick the spot in 3D.')}
        </div>
        <button disabled={!dims || !!error || busy}
          onClick={() => {
            if (!dims) return;
            setNotice(null);
            setPlacing({ kind: 'new', floor: floor.number, type, name: name.trim(), ...dims });
            setArea(''); setWidth(''); setName('');
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', padding: '0.6rem',
            borderRadius: '8px', border: 'none', fontSize: '0.78rem', fontWeight: 700,
            background: !dims || error ? 'rgba(60,52,44,0.072)' : '#5d6b80',
            color: !dims || error ? 'var(--text-tertiary)' : '#fff', cursor: !dims || error ? 'not-allowed' : 'pointer',
          }}>
          <MousePointerClick size={14} /> Place it in the 3D view
        </button>
      </div>
    </>
  );
}

/* ── Windows: only what the user adds is built ── */
function WindowsTab({ floor, busy, onSave }: {
  floor: Floor; busy: boolean; onSave: (room: Room, spec: WindowSpec) => Promise<boolean>;
}) {
  const placed = floor.rooms.filter(isPlaced);
  const [roomId, setRoomId] = useState(placed[0]?.id ?? '');
  const room = placed.find(r => r.id === roomId) ?? placed[0];

  if (!room) return <div style={HINT}>Place a room on Floor {floor.number} first — windows go on its outside walls.</div>;

  const outside = SIDES.map(side => ({ side, length: exteriorLength(floor, room, side) })).filter(s => s.length > 0);
  const glazing = room.windows.reduce((s, w) => s + w.count * w.width_ft * w.height_ft, 0);
  const need = suggestedGlazingSqft(room);

  const addSuggested = async () => {
    for (const { side, length } of outside) {
      const spec = suggestedWindows(room, side, length);
      if (spec.count > 0 && !(await onSave(room, spec))) return;
    }
  };

  return (
    <>
      <label style={LABEL}>
        WHICH ROOM?
        <select style={{ ...FIELD, marginTop: '0.25rem' }} value={room.id} onChange={e => setRoomId(e.target.value)}>
          {placed.map(r => <option key={r.id} value={r.id} style={{ background: '#efebe4' }}>{roomMeta(r.type).symbol} {r.name} ({r.area_sqft} sq ft)</option>)}
        </select>
      </label>
      <div style={{ ...HINT, padding: '0.5rem 0.6rem', borderRadius: '8px', background: glazing >= need ? 'rgba(76,107,73,0.08)' : 'rgba(165,124,58,0.08)' }}>
        Suggested (NBC 2016): at least <b style={{ color: '#3d3a35' }}>{need} sq ft</b> of window
        {room.type === 'bathroom' ? ' (a high ventilator)' : ` (1/10 of ${room.area_sqft} sq ft)`}.
        Added so far: <b style={{ color: glazing >= need ? '#4c6b49' : '#8c6a2f' }}>{Math.round(glazing)} sq ft</b>.
        {room.type !== 'bathroom' && outside.length > 1 && ' Windows on two different walls give cross-ventilation.'}
      </div>
      {outside.length === 0 ? (
        <div style={HINT}>{room.name} has no outside walls — move it to an edge of the floor to give it windows.</div>
      ) : (
        <button disabled={busy} onClick={addSuggested} style={{ ...FIELD, cursor: 'pointer', fontWeight: 700, color: '#4f7d78', borderColor: 'rgba(79,125,120,0.4)' }}>
          Add suggested windows to {room.name}
        </button>
      )}
      {SIDES.map(side => {
        const length = exteriorLength(floor, room, side);
        const spec = userWindows(room, side);
        return (
          <SideRow key={`${room.id}-${side}-${spec ? `${spec.count}-${spec.width_ft}-${spec.height_ft}` : 'none'}`}
            side={side} length={length} spec={spec} suggestion={suggestedWindows(room, side, length)}
            busy={busy} onSave={spec => onSave(room, spec)} />
        );
      })}
      <div style={HINT}>Front = road side. Only windows you add are built; count 0 removes them.</div>
    </>
  );
}

function SideRow({ side, length, spec, suggestion, busy, onSave }: {
  side: WallSide; length: number; spec?: WindowSpec; suggestion: WindowSpec; busy: boolean; onSave: (spec: WindowSpec) => void;
}) {
  const start = spec ?? { ...suggestion, count: Math.max(1, suggestion.count) };
  const [count, setCount] = useState(String(start.count));
  const [w, setW] = useState(String(start.width_ft));
  const [h, setH] = useState(String(start.height_ft));
  const label = side[0].toUpperCase() + side.slice(1);

  if (!length) {
    return <div style={{ fontSize: '0.64rem', color: 'var(--text-tertiary)' }}><b>{label}</b> · inside wall, no windows possible</div>;
  }
  const cell = { ...FIELD, padding: '0.3rem 0.35rem', fontSize: '0.74rem' };
  return (
    <div style={{ border: `1px solid ${spec?.count ? 'rgba(79,125,120,0.4)' : 'var(--border-subtle)'}`, borderRadius: '8px', padding: '0.45rem 0.5rem' }}>
      <div style={{ display: 'flex', fontSize: '0.68rem', fontWeight: 700, color: '#3d3a35', marginBottom: '0.3rem' }}>
        {label} wall · {length} ft
        <span style={{ marginLeft: 'auto', fontWeight: 600, color: spec?.count ? '#4f7d78' : 'var(--text-tertiary)' }}>
          {spec?.count ? `${spec.count} added` : 'none'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '0.3rem', alignItems: 'end' }}>
        <label style={LABEL}>COUNT<input style={cell} type="number" min={0} max={12} value={count} onChange={e => setCount(e.target.value)} /></label>
        <label style={LABEL}>W (FT)<input style={cell} type="number" min={1} max={16} step={0.5} value={w} onChange={e => setW(e.target.value)} /></label>
        <label style={LABEL}>H (FT)<input style={cell} type="number" min={1} max={7} step={0.5} value={h} onChange={e => setH(e.target.value)} /></label>
        <button disabled={busy} onClick={() => onSave({ side, count: parseInt(count, 10) || 0, width_ft: parseFloat(w) || 4, height_ft: parseFloat(h) || 4 })}
          style={{ ...cell, width: 'auto', cursor: 'pointer', background: 'rgba(110,104,144,0.25)', borderColor: '#6e6890', fontWeight: 700 }}>
          {spec ? 'Update' : 'Add'}
        </button>
      </div>
    </div>
  );
}

/* ── Wall thickness with suggestions ── */
function WallsTab({ state, busy, onSave }: { state: BuildingState; busy: boolean; onSave: (ext: number, int: number) => void }) {
  const { exteriorWallIn, interiorWallIn } = state.constraints;
  const [ext, setExt] = useState(exteriorWallIn);
  const [int, setInt] = useState(interiorWallIn);
  const sugg = suggestWalls(state.district, state.floors.length);

  // Outer walls eat into usable (carpet) area: perimeter × thickness
  const perimeter = (state.floors[0]?.footprint ?? state.site.footprint).reduce((s, p) => s + 2 * (p.w + p.d), 0);
  const lostSqft = Math.round(perimeter * (ext / 12) * 0.5); // shared edges between parts roughly halve it

  const pick = (value: number, set: (v: number) => void, options: number[]) => (
    <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
      {options.map(o => (
        <button key={o} onClick={() => set(o)} style={{
          padding: '0.3rem 0.5rem', borderRadius: '6px', fontSize: '0.68rem', fontWeight: 700, cursor: 'pointer',
          background: value === o ? 'rgba(110,104,144,0.25)' : 'rgba(60,52,44,0.048)',
          border: `1px solid ${value === o ? '#6e6890' : 'var(--border-subtle)'}`,
          color: value === o ? '#4f4a6e' : 'var(--text-secondary)',
        }}>{o}″<span style={{ opacity: 0.6, fontWeight: 500 }}> {inchToMm(o)}mm</span></button>
      ))}
    </div>
  );

  return (
    <>
      <div style={{ ...HINT, color: '#3d3a35' }}>
        Current: <b>{exteriorWallIn}″</b> outside ({inchToMm(exteriorWallIn)} mm) · <b>{interiorWallIn}″</b> inside ({inchToMm(interiorWallIn)} mm)
      </div>
      <div style={LABEL}>EXTERIOR WALLS{pick(ext, setExt, WALL_OPTIONS_IN)}</div>
      <div style={LABEL}>INTERIOR WALLS{pick(int, setInt, WALL_OPTIONS_IN.filter(o => o <= 9))}</div>
      <div style={HINT}>Outer walls at {ext}″ take roughly {lostSqft} sq ft of each floor's built-up area.</div>
      <div style={{ padding: '0.55rem 0.65rem', borderRadius: '8px', background: 'rgba(79,125,120,0.07)', border: '1px solid rgba(79,125,120,0.25)' }}>
        <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#4f7d78', marginBottom: '0.3rem' }}>
          Suggested for {state.district.name}, {state.floors.length || 1} floor(s): {sugg.exteriorIn}″ outer / {sugg.interiorIn}″ inner
        </div>
        <ul style={{ margin: 0, paddingLeft: '1rem', ...HINT }}>
          {sugg.reasons.map((r, i) => <li key={i} style={{ marginBottom: '0.2rem' }}>{r}</li>)}
        </ul>
        <button onClick={() => { setExt(sugg.exteriorIn); setInt(sugg.interiorIn); }}
          style={{ ...FIELD, marginTop: '0.35rem', padding: '0.3rem', fontSize: '0.7rem', cursor: 'pointer' }}>Use suggestion</button>
      </div>
      <button disabled={busy || (ext === exteriorWallIn && int === interiorWallIn)} onClick={() => onSave(ext, int)}
        style={{ padding: '0.55rem', borderRadius: '8px', border: 'none', fontWeight: 700, fontSize: '0.78rem', cursor: 'pointer',
          background: '#5d6b80', color: '#fff',
          opacity: ext === exteriorWallIn && int === interiorWallIn ? 0.45 : 1 }}>
        Save wall thickness
      </button>
    </>
  );
}

/* ── A different shape per floor ── */
function ShapesTab({ floors, busy, onSet }: { floors: Floor[]; busy: boolean; onSet: (n: number, shape: string) => void }) {
  const { setFocusFloor } = useDesign();
  return (
    <>
      <div style={HINT}>
        Give each floor its own shape — e.g. two rectangle floors with a pyramid on top. Each floor must sit
        within the one below it (no overhangs); rooms that no longer fit go back to "not placed".
      </div>
      {[...floors].reverse().map(f => (
        <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ width: '2.4rem', fontSize: '0.72rem', fontWeight: 700, color: '#3d3a35' }}>F{f.number}</span>
          <select disabled={busy} value={f.shape} onChange={e => onSet(f.number, e.target.value)} style={{ ...FIELD, padding: '0.35rem 0.45rem' }}>
            {SHAPES.map(s => <option key={s.id} value={s.id} style={{ background: '#efebe4' }}>{s.label}</option>)}
          </select>
          <span style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{f.area_sqft} ft²</span>
        </div>
      ))}
      <button onClick={() => setFocusFloor(null)} style={{ ...FIELD, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}>
        <Eye size={13} /> Show the whole building in 3D
      </button>
    </>
  );
}
