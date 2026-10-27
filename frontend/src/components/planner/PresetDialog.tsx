import { useMemo, useState } from 'react';
import { X, Wand2, MousePointerClick, Trash2 } from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';
import { useDesign } from '../../context/DesignContext';
import { addRoomsBatch, sendMessage } from '../../services/api';
import { roomMeta, defaultDims, ROOM_META } from '../../utils/rooms';
import { fitSizes, minSqft, type Preset, type PresetRoom } from '../../utils/presets';

const NEW_FLOOR = -1;

const FIELD: React.CSSProperties = {
  boxSizing: 'border-box', padding: '0.4rem 0.5rem', background: 'rgba(60,52,44,0.072)',
  border: '1px solid var(--border-subtle)', borderRadius: '7px', color: '#2b2926', fontSize: '0.8rem',
};

/**
 * "Add a 2BHK" — asks which floor it goes on (the one you're working on by
 * default, never a new floor unless you pick it), suggests a size for every
 * room that fits the free space, and lets you edit them before anything is built.
 */
export function PresetDialog() {
  const { preset } = useDesign();
  if (!preset) return null;
  // Remount per preset so the form starts fresh
  return <PresetForm key={preset.id} preset={preset} />;
}

function PresetForm({ preset }: { preset: Preset }) {
  const { state, dispatch } = useBuilding();
  const { focusFloor, setFocusFloor, openPreset, setNotice, setPlacing } = useDesign();
  const floors = [...state.floors].sort((a, b) => a.number - b.number);
  const startFloor = focusFloor ?? floors[floors.length - 1]?.number ?? NEW_FLOOR;

  const [chosen, setTarget] = useState<number>(startFloor);
  // If the chosen floor disappears (e.g. the page re-synced with the server), fall back to the top floor
  const target = chosen === NEW_FLOOR || floors.some(f => f.number === chosen)
    ? chosen : floors[floors.length - 1]?.number ?? NEW_FLOOR;
  const [rooms, setRooms] = useState<PresetRoom[]>(preset.rooms);
  const floorArea = target === NEW_FLOOR ? state.constraints.floorAreaSqft
    : floors.find(f => f.number === target)?.area_sqft ?? 0;
  const used = target === NEW_FLOOR ? 0 : (floors.find(f => f.number === target)?.rooms ?? []).reduce((s, r) => s + r.area_sqft, 0);
  const free = floorArea - used;

  // Suggested sizes re-fit whenever the floor (free space) or room list changes, until the user edits them
  const suggested = useMemo(() => fitSizes(rooms, free), [rooms, free]);
  const [edited, setEdited] = useState<Record<number, string>>({});
  const sizes = rooms.map((_, i) => (edited[i] !== undefined ? parseInt(edited[i], 10) || 0 : suggested[i]));
  const actual = sizes.map(a => { const { w, d } = defaultDims(Math.max(a, 1)); return w * d; });
  const total = actual.reduce((a, b) => a + b, 0);
  const tooSmall = rooms.findIndex((r, i) => sizes[i] < minSqft(r.type));
  const error = rooms.length === 0 ? 'Add at least one room.'
    : total > free ? `These rooms need ${total} sq ft but ${target === NEW_FLOOR ? 'a new floor' : `Floor ${target}`} has ${free} sq ft free.`
    : tooSmall >= 0 ? `${rooms[tooSmall].name ?? rooms[tooSmall].type} should be at least ${minSqft(rooms[tooSmall].type)} sq ft.`
    : null;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const close = () => openPreset(null);

  const build = async (arrange: boolean) => {
    if (error || busy) return;
    setBusy(true); setFailure(null);
    try {
      let floorNo = target;
      if (floorNo === NEW_FLOOR) {
        const res = await sendMessage('add a floor');
        if (!res.updatedState || res.message_type === 'error') throw new Error(res.message);
        dispatch({ type: 'SET_STATE', payload: res.updatedState });
        floorNo = Math.max(...res.updatedState.floors.map(f => f.number));
      }
      const next = await addRoomsBatch(floorNo, rooms.map((r, i) => ({ type: r.type, area_sqft: sizes[i], name: r.name })), arrange);
      dispatch({ type: 'SET_STATE', payload: next });
      setFocusFloor(floorNo);
      const floor = next.floors.find(f => f.number === floorNo);
      const waiting = floor?.rooms.filter(r => r.x === null).length ?? 0;
      setNotice({
        text: arrange
          ? `${preset.label} added to Floor ${floorNo}. ${waiting ? `${waiting} room(s) didn't fit automatically — place them yourself. ` : ''}Use Move / Rotate to change the layout.`
          : `${preset.label} rooms added to Floor ${floorNo}. Click "Place" on each one to choose its spot.`,
        error: false,
      });
      // Start placing the first waiting room straight away
      const first = floor?.rooms.find(r => r.x === null);
      if (!arrange && first) setPlacing({ kind: 'existing', floor: floorNo, roomId: first.id, type: first.type, name: first.name, w: first.w, d: first.d });
      close();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };

  return (
    <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 950, background: 'rgba(60,52,44,0.21)', backdropFilter: 'blur(6px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(560px, 94vw)', maxHeight: '90vh', overflowY: 'auto', background: '#fbfaf7',
        border: '1px solid var(--border-subtle)', borderRadius: '14px', padding: '1.1rem 1.2rem', boxShadow: '0 20px 60px rgba(60,52,44,0.175)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <span style={{ fontSize: '1.4rem' }}>{preset.emoji}</span>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#2b2926' }}>Add a {preset.label}</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>{preset.desc}</div>
          </div>
          <button onClick={close} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><X size={18} /></button>
        </div>

        {/* 1. Which floor */}
        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)', marginBottom: '0.35rem' }}>1 · WHICH FLOOR?</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
            {floors.map(f => {
              const freeF = f.area_sqft - f.rooms.reduce((s, r) => s + r.area_sqft, 0);
              return (
                <FloorChip key={f.id} active={target === f.number} onClick={() => { setTarget(f.number); setEdited({}); }}
                  label={`Floor ${f.number}${f.number === focusFloor ? ' (current)' : ''}`} sub={`${freeF} sq ft free`} />
              );
            })}
            <FloorChip active={target === NEW_FLOOR} onClick={() => { setTarget(NEW_FLOOR); setEdited({}); }}
              label="+ New floor" sub={`${state.constraints.floorAreaSqft} sq ft`} />
          </div>
        </div>

        {/* 2. Sizes */}
        <div style={{ marginTop: '1rem' }}>
          <div style={{ display: 'flex', fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)', marginBottom: '0.35rem' }}>
            2 · ROOM SIZES (SUGGESTED — EDIT ANY)
            <span style={{ marginLeft: 'auto', color: total > free ? '#9a5040' : '#4c6b49', letterSpacing: 0 }}>{total} / {free} sq ft</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {rooms.map((r, i) => {
              const m = roomMeta(r.type);
              const { w, d } = defaultDims(Math.max(sizes[i], 1));
              return (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.35rem 0.5rem', borderRadius: '8px', background: `${m.color}10`, border: `1px solid ${m.color}40` }}>
                  <span style={{ width: '1.3rem' }}>{m.symbol}</span>
                  <input value={r.name ?? ''} placeholder={r.type} onChange={e => setRooms(rs => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    style={{ ...FIELD, flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: '0.2rem', fontWeight: 600 }} />
                  <input type="number" min={minSqft(r.type)} value={edited[i] ?? String(suggested[i])}
                    onChange={e => setEdited(ed => ({ ...ed, [i]: e.target.value }))}
                    style={{ ...FIELD, width: '4.6rem', textAlign: 'right', fontWeight: 700 }} />
                  <span style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', width: '5.2rem' }}>sq ft · {w}×{d} ft</span>
                  <button title="Remove" onClick={() => { setRooms(rs => rs.filter((_, j) => j !== i)); setEdited({}); }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: 0 }}><Trash2 size={13} /></button>
                </div>
              );
            })}
          </div>
          <select value="" onChange={e => { if (e.target.value) { setRooms(rs => [...rs, { type: e.target.value }]); setEdited({}); } }}
            style={{ ...FIELD, marginTop: '0.4rem', width: '100%', cursor: 'pointer' }}>
            <option value="" style={{ background: '#efebe4' }}>+ Add another room…</option>
            {Object.keys(ROOM_META).map(t => <option key={t} value={t} style={{ background: '#efebe4' }}>{ROOM_META[t].symbol} {t}</option>)}
          </select>
          <div style={{ fontSize: '0.64rem', color: 'var(--text-tertiary)', marginTop: '0.4rem', lineHeight: 1.5 }}>
            Suggestions use typical Indian sizes (master bedroom 160, bedroom 140, hall 200, kitchen 90, bathroom 45 sq ft),
            scaled down to fit the free space and never below NBC minimums. About 15% is left for walls and passages.
          </div>
        </div>

        {(error || failure) && (
          <div style={{ marginTop: '0.75rem', fontSize: '0.72rem', color: '#9a5040', background: 'rgba(154,80,64,0.08)', borderRadius: '8px', padding: '0.5rem 0.6rem' }}>{failure ?? error}</div>
        )}

        {/* 3. How to place */}
        <div style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)', margin: '1rem 0 0.35rem' }}>3 · HOW DO YOU WANT TO PLACE THEM?</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
          <BigBtn disabled={!!error || busy} primary onClick={() => build(true)} icon={<Wand2 size={15} />}
            title="Arrange for me" sub="A starting layout you can move & rotate" />
          <BigBtn disabled={!!error || busy} onClick={() => build(false)} icon={<MousePointerClick size={15} />}
            title="I'll place each room" sub="Click every room's spot in 3D" />
        </div>
      </div>
    </div>
  );
}

function FloorChip({ active, onClick, label, sub }: { active: boolean; onClick: () => void; label: string; sub: string }) {
  return (
    <button onClick={onClick} style={{
      padding: '0.4rem 0.7rem', borderRadius: '8px', cursor: 'pointer', textAlign: 'left',
      background: active ? 'rgba(110,104,144,0.25)' : 'rgba(60,52,44,0.048)',
      border: `1px solid ${active ? '#6e6890' : 'var(--border-subtle)'}`,
    }}>
      <div style={{ fontSize: '0.76rem', fontWeight: 700, color: active ? '#4f4a6e' : 'var(--text-secondary)' }}>{label}</div>
      <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{sub}</div>
    </button>
  );
}

function BigBtn({ disabled, primary, onClick, icon, title, sub }: {
  disabled: boolean; primary?: boolean; onClick: () => void; icon: React.ReactNode; title: string; sub: string;
}) {
  return (
    <button disabled={disabled} onClick={onClick} style={{
      padding: '0.65rem', borderRadius: '10px', textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
      background: primary ? '#5d6b80' : 'rgba(60,52,44,0.06)',
      border: primary ? 'none' : '1px solid var(--border-subtle)', color: primary ? '#fff' : 'var(--text-primary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', fontWeight: 800 }}>{icon}{title}</div>
      <div style={{ fontSize: '0.64rem', opacity: 0.8, marginTop: '0.15rem' }}>{sub}</div>
    </button>
  );
}

