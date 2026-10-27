import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { RotateCcw, ZoomIn, ZoomOut, Plus, Eye, EyeOff, Layers, LayoutGrid, MapPin, Maximize2, Minimize2, Box, Square } from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';
import { sendMessage } from '../../services/api';
import { siteCoords } from '../../services/liveData';
import { FloorPlanEditor } from '../planner/FloorPlanEditor';
import { SiteMapView } from './SiteMapView';
import { ROOM_META, SITE_META, roomMeta, insideUnion, overlaps } from '../../utils/rooms';
import { userWindows } from '../../utils/walls';
import { placeRoom, updateRoom } from '../../services/api';
import { useDesign } from '../../context/DesignContext';
import type { Floor, Room, Rect, SiteFeature, WindowSpec } from '../../context/BuildingContext';

/* ── Palette ── */
const PALETTE = [
  { top: '#e4eaec', front: '#d9e1e2', side: '#bcc5c8', back: '#a7b1b4', bottom: '#879397', label: '#44626a' },
  { top: '#e4ece8', front: '#d9e2de', side: '#bcc8c2', back: '#a7b4ae', bottom: '#87978f', label: '#446a58' },
  { top: '#ece4e7', front: '#e2d9dc', side: '#c8bcc0', back: '#b4a7ab', bottom: '#97878c', label: '#6a4450' },
  { top: '#eceae4', front: '#e2e0d9', side: '#c8c5bc', back: '#b4b1a7', bottom: '#979387', label: '#6a6044' },
  { top: '#e4e4ec', front: '#d9d9e2', side: '#bcbcc8', back: '#a7a7b4', bottom: '#878797', label: '#44446a' },
  { top: '#e9e4ec', front: '#dfd9e2', side: '#c4bcc8', back: '#b0a7b4', bottom: '#928797', label: '#5d446a' },
  { top: '#e4ece9', front: '#d9e2df', side: '#bcc8c3', back: '#a7b4af', bottom: '#879790', label: '#446a5a' },
  { top: '#ece7e4', front: '#e2ddd9', side: '#c8c1bc', back: '#b4aca7', bottom: '#978d87', label: '#6a5344' },
  { top: '#e4e9ec', front: '#d9dfe2', side: '#bcc3c8', back: '#a7afb4', bottom: '#879097', label: '#445a6a' },
  { top: '#ece4e7', front: '#e2d9dd', side: '#c8bcc1', back: '#b4a7ac', bottom: '#97878d', label: '#6a4453' },
];
const pc = (i: number) => PALETTE[i % PALETTE.length];

/* ── Building geometry ──
   Plans are in feet; BASE_W px is the width of the ground-floor bounding box
   and every other dimension scales from it. */
const BASE_W = 260;
const FLOOR_H = 64;
const ROOF_H = 10;
const LINTEL_H = 6;     // solid band at the top of each façade (slab edge)
const DOOR_W = 14;
const EXPLODE_GAP = 48; // vertical gap between floors in exploded view
const ROAD_H = 16;
const STOREY_FT = 10;               // FLOOR_H represents a 10 ft storey
const VFT = FLOOR_H / STOREY_FT;    // vertical px per ft
const PERSPECTIVE = 1400;
const PLAN_WALL_H = 12;             // walls are cut this low on the floor being planned

/* ── 3D plane helpers ──
   World space: x → right, y → down (ground at y=0, floors stack into −y),
   z → towards the viewer. Every plane is anchored by its top-left corner. */
const plane = (w: number, h: number, transform: string): React.CSSProperties => ({
  position: 'absolute', left: 0, top: 0,
  width: `${w}px`, height: `${h}px`,
  transformOrigin: '0 0', transform, boxSizing: 'border-box',
});
/** Horizontal plane at height y covering x∈[x, x+w], z∈[z, z+d]. */
const flat = (x: number, y: number, z: number, w: number, d: number) =>
  plane(w, d, `translate3d(${x}px,${y}px,${z}px) rotateX(90deg)`);
/** Vertical wall in the plane z=const, running along +x. */
const wallX = (x: number, yTop: number, z: number, len: number, h: number) =>
  plane(len, h, `translate3d(${x}px,${yTop}px,${z}px)`);
/** Vertical wall in the plane x=const, running along +z. */
const wallZ = (x: number, yTop: number, z: number, len: number, h: number) =>
  plane(len, h, `translate3d(${x}px,${yTop}px,${z}px) rotateY(-90deg)`);
/** Card that always faces the camera, centred on a world point. */
const billboard = (x: number, y: number, z: number, rotX: number, rotY: number): React.CSSProperties => ({
  position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', pointerEvents: 'none',
  transform: `translate3d(${x}px,${y}px,${z}px) rotateY(${-rotY}deg) rotateX(${-rotX}deg) translate(-50%,-50%)`,
});

/* ── Walls from the user's plan ──
   Rasterise the floor into 1-ft cells (outside / open / room), then every
   boundary between two different cells is a wall: footprint edges become
   façades, room edges become partitions. Consecutive edges are merged. */
type Facing = 'front' | 'back' | 'left' | 'right';
interface ExtRun { axis: 'x' | 'z'; x: number; z: number; len: number; room: Room | null; facing: Facing }
interface IntRun { axis: 'x' | 'z'; x: number; z: number; len: number }

function planWalls(footprint: Rect[], rooms: Room[], W: number, D: number) {
  const placed = rooms.filter(r => r.x !== null && r.z !== null);
  const grid = new Int16Array(W * D).fill(-1);
  for (const p of footprint)
    for (let z = p.z; z < p.z + p.d; z++) for (let x = p.x; x < p.x + p.w; x++) grid[z * W + x] = 0;
  placed.forEach((r, i) => {
    for (let z = r.z!; z < r.z! + r.d; z++) for (let x = r.x!; x < r.x! + r.w; x++)
      if (x >= 0 && x < W && z >= 0 && z < D && grid[z * W + x] >= 0) grid[z * W + x] = i + 1;
  });
  const cell = (x: number, z: number) => (x < 0 || z < 0 || x >= W || z >= D ? -1 : grid[z * W + x]);

  const ext: ExtRun[] = [];
  const int: IntRun[] = [];
  // Scan one grid line; `pair(t)` returns the cells on either side at position t.
  const scan = (axis: 'x' | 'z', c: number, n: number, pair: (t: number) => [number, number]) => {
    let key = '', start = 0;
    const flush = (end: number) => {
      if (!key) return;
      const len = end - start;
      const [x, z] = axis === 'x' ? [start, c] : [c, start];
      if (key.startsWith('e')) {
        const [, facing, owner] = key.split(':');
        ext.push({ axis, x, z, len, facing: facing as Facing, room: +owner > 0 ? placed[+owner - 1] : null });
      } else int.push({ axis, x, z, len });
    };
    for (let t = 0; t <= n; t++) {
      let k = '';
      if (t < n) {
        const [a, b] = pair(t);
        if ((a < 0) !== (b < 0)) {
          const facing = axis === 'x' ? (a >= 0 ? 'front' : 'back') : (a >= 0 ? 'right' : 'left');
          k = `e:${facing}:${a >= 0 ? a : b}`;
        } else if (a >= 0 && a !== b) k = `i:${Math.min(a, b)}-${Math.max(a, b)}`;
      }
      if (k !== key) { flush(t); key = k; start = t; }
    }
  };
  for (let z = 0; z <= D; z++) scan('x', z, W, x => [cell(x, z - 1), cell(x, z)]);
  for (let x = 0; x <= W; x++) scan('z', x, D, z => [cell(x - 1, z), cell(x, z)]);
  return { ext, int, placed };
}

const FACING_LIGHT: Record<Facing, number> = { front: 1, right: 0.85, left: 0.7, back: 0.6 };

/**
 * The part of a floor's top not covered by the floor above (e.g. beside an L,
 * U or T storey, or the rim round a smaller pyramid storey). Returns the roof
 * slabs to draw, and parapet runs only on its outer edges — where it meets the
 * upper floor, that floor's wall rises instead.
 */
function exposedRoof(footprint: Rect[], above: Rect[], W: number, D: number) {
  const mark = (rects: Rect[]) => {
    const g = new Uint8Array(W * D);
    for (const p of rects)
      for (let z = Math.max(0, p.z); z < Math.min(D, p.z + p.d); z++)
        for (let x = Math.max(0, p.x); x < Math.min(W, p.x + p.w); x++) g[z * W + x] = 1;
    return g;
  };
  const own = mark(footprint), up = mark(above);
  const exposed = (x: number, z: number) => x >= 0 && z >= 0 && x < W && z < D && own[z * W + x] === 1 && up[z * W + x] === 0;
  const outside = (x: number, z: number) => x < 0 || z < 0 || x >= W || z >= D || own[z * W + x] === 0;

  // Slabs: runs along each row, merged downwards while the run stays the same
  const slabs: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let z = 0; z <= D; z++) {
    const next = new Map<string, Rect>();
    for (let x = 0; z < D && x < W;) {
      if (!exposed(x, z)) { x++; continue; }
      const x0 = x;
      while (x < W && exposed(x, z)) x++;
      const key = `${x0}:${x}`;
      const r = open.get(key);
      if (r) { r.d++; next.set(key, r); open.delete(key); } else next.set(key, { x: x0, z, w: x - x0, d: 1 });
    }
    open.forEach(r => slabs.push(r));
    open = next;
  }

  // Parapets: edges between an exposed cell and the outside, merged into runs
  const edges: { axis: 'x' | 'z'; x: number; z: number; len: number; facing: Facing }[] = [];
  const scan = (axis: 'x' | 'z', c: number, n: number, side: (t: number) => Facing | null) => {
    let cur: Facing | null = null, start = 0;
    for (let t = 0; t <= n; t++) {
      const f = t < n ? side(t) : null;
      if (f !== cur) {
        if (cur) edges.push({ axis, x: axis === 'x' ? start : c, z: axis === 'x' ? c : start, len: t - start, facing: cur });
        cur = f; start = t;
      }
    }
  };
  for (let z = 0; z <= D; z++)
    scan('x', z, W, x => (exposed(x, z - 1) && outside(x, z) ? 'front' : exposed(x, z) && outside(x, z - 1) ? 'back' : null));
  for (let x = 0; x <= W; x++)
    scan('z', x, D, z => (exposed(x - 1, z) && outside(x, z) ? 'right' : exposed(x, z) && outside(x - 1, z) ? 'left' : null));
  return { slabs, edges };
}

/** Where the main entrance goes: a front-facing ground-floor wall, preferring the hallway / living room. */
function entrance(ext: ExtRun[]): ExtRun | null {
  const front = ext.filter(r => r.facing === 'front');
  if (front.length === 0) return null;
  return front.find(r => r.room?.type === 'hallway') ?? front.find(r => r.room?.type === 'living')
    ?? front.reduce((a, b) => (b.len > a.len ? b : a));
}

/* ── Façade segment: plaster wall with framed windows ── */
function FacadeRun({ run, k, H, colors, windows, hasDoor, children }: {
  run: ExtRun; k: number; H: number; colors: ReturnType<typeof pc>; windows: WindowSpec | null; hasDoor: boolean; children?: React.ReactNode;
}) {
  const len = run.len * k;
  const pos = run.axis === 'x' ? wallX(run.x * k, -H, run.z * k, len, H) : wallZ(run.x * k, -H, run.z * k, len, H);
  const tint = run.room ? roomMeta(run.room.type).color : colors.label;
  const n = windows?.count ?? 0;
  // Windows share the wall evenly; on the entrance wall they go either side of the door
  const spans: [number, number][] = hasDoor ? [[0, len / 2 - 16], [len / 2 + 16, len]] : [[0, len]];
  const perSpan = hasDoor ? [Math.ceil(n / 2), Math.floor(n / 2)] : [n];
  const ww = Math.min((windows?.width_ft ?? 0) * k, Math.min(...spans.map(([a, b], i) => (b - a) / Math.max(perSpan[i], 1) - 4)));
  const lefts = spans.flatMap(([a, b], i) => {
    const m = perSpan[i];
    const gap = (b - a - m * ww) / (m + 1);
    return Array.from({ length: m }, (_, j) => a + gap + j * (ww + gap));
  });
  const high = run.room?.type === 'bathroom';                 // ventilators sit high
  const wh = Math.min((windows?.height_ft ?? 0) * VFT, H - LINTEL_H - 8);
  const bottom = high ? H - LINTEL_H - 4 - wh : Math.min(3 * VFT, H - LINTEL_H - 4 - wh);
  return (
    <div style={{
      ...pos,
      background: `linear-gradient(180deg, ${colors.top} 0 ${LINTEL_H}px, ${colors.front} ${LINTEL_H}px calc(100% - 4px), ${colors.bottom} calc(100% - 4px))`,
      borderLeft: `2px solid ${colors.side}`,
      borderRight: `2px solid ${colors.side}`,
      filter: `brightness(${FACING_LIGHT[run.facing]})`,
    }}>
      {ww > 2 && lefts.map((left, i) => (
        <div key={i} style={{
          position: 'absolute', left: `${left}px`, bottom: `${bottom}px`, width: `${ww}px`, height: `${wh}px`,
          boxSizing: 'border-box', border: '1.5px solid #5a554d', borderRadius: '1px',
          background: `linear-gradient(135deg, rgba(221,230,236,0.75) 0%, rgba(180,196,216,0.45) 35%, ${tint}55 60%, rgba(95,127,124,0.6) 100%)`,
          boxShadow: '0 1px 0 #8f897f, inset 0 0 4px rgba(255,255,255,0.35)',
        }}>
          {/* mullion + transom */}
          {ww > 10 && <div style={{ position: 'absolute', top: 0, bottom: 0, left: '50%', width: '1px', background: '#5a554d' }} />}
          {wh > 14 && <div style={{ position: 'absolute', left: 0, right: 0, top: '32%', height: '1px', background: '#5a554d' }} />}
          {/* sill ledge */}
          <div style={{ position: 'absolute', left: '-2px', right: '-2px', bottom: '-3px', height: '2px', background: '#8f897f' }} />
        </div>
      ))}
      {children}
    </div>
  );
}

/** Windows to draw on each exterior run — only those the user added, all on the room's longest run for that side. */
function windowsByRun(ext: ExtRun[]): Map<ExtRun, WindowSpec | null> {
  const out = new Map<ExtRun, WindowSpec | null>();
  const groups = new Map<string, ExtRun[]>();
  for (const r of ext) {
    if (!r.room) continue;
    const key = `${r.room.id}:${r.facing}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const runs of groups.values()) {
    const main = runs.reduce((a, b) => (b.len > a.len ? b : a));
    const spec = userWindows(main.room!, main.facing) ?? null;
    for (const r of runs) out.set(r, r === main ? spec : null);
  }
  return out;
}

/**
 * A wall's thickness made visible: the inner face (a second plane `t` px inside
 * the outer one) and the cap on top. `inward` is the side the building is on.
 */
function WallBody({ axis, x, z, len, t, H, inward, cap, face, pulse }: {
  axis: 'x' | 'z'; x: number; z: number; len: number; t: number; H: number; inward: -1 | 0 | 1;
  cap: string; face: string | null; pulse: number;
}) {
  const off = inward === 1 ? 0 : inward === -1 ? -t : -t / 2;
  const anim = pulse ? { animation: 'wallPulse 0.9s ease-in-out 3' } : {};
  const capStyle = axis === 'x' ? flat(x, -H, z + off, len, t) : flat(x + off, -H, z, t, len);
  const inner = inward === 0 ? null : axis === 'x' ? wallX(x, -H, z + inward * t, len, H) : wallZ(x + inward * t, -H, z, len, H);
  return (
    <>
      <div key={`c${pulse}`} style={{ ...capStyle, background: cap, ...anim }} />
      {inner && face && <div key={`f${pulse}`} style={{ ...inner, background: face, ...anim }} />}
    </>
  );
}

/* ── Sloped faces (pyramid floors) ──
   A plane through world point O whose local x runs along U and local y along V
   (both unit vectors), so any tilted face can be placed exactly, then cut to
   a trapezoid / triangle with clip-path. */
type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function slopedFace(O: V3, U: V3, V: V3, w: number, h: number, clip: string): React.CSSProperties {
  const u = norm(U), v = norm(V), n = norm(cross(u, v));
  return {
    position: 'absolute', left: 0, top: 0, width: `${w}px`, height: `${h}px`, transformOrigin: '0 0',
    transform: `matrix3d(${u.join(',')},0,${v.join(',')},0,${n.join(',')},0,${O.join(',')},1)`,
    clipPath: clip,
  };
}

/** Pointed cap on a top-floor pyramid: four triangles rising from the floor's walls to the apex. */
function PyramidRoof({ fp, k, H, colors }: { fp: Rect[]; k: number; H: number; colors: ReturnType<typeof pc> }) {
  const bx0 = Math.min(...fp.map(p => p.x)) * k, bz0 = Math.min(...fp.map(p => p.z)) * k;
  const bx1 = Math.max(...fp.map(p => p.x + p.w)) * k, bz1 = Math.max(...fp.map(p => p.z + p.d)) * k;
  const x0 = bx0, x1 = bx1, z0 = bz0, z1 = bz1;   // the storey's own outline — it steps in per floor already
  const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const P = Math.min(W, D) * 0.55;                                     // apex height
  const top = -H - P;
  const Lf = Math.hypot(P, D / 2), Ls = Math.hypot(P, W / 2);
  const tri = 'polygon(50% 0, 100% 100%, 0 100%)';
  const skin = (light: number): React.CSSProperties => ({
    background: `repeating-linear-gradient(0deg, rgba(255,255,255,0.18) 0 1px, transparent 1px 10px), linear-gradient(180deg, ${colors.label}, ${colors.top})`,
    filter: `brightness(${light})`,
  });
  return (
    <>
      <div style={{ ...slopedFace([x0, top, cz], [1, 0, 0], [0, P, D / 2], W, Lf, tri), ...skin(1) }} />
      <div style={{ ...slopedFace([x0, top, cz], [1, 0, 0], [0, P, -D / 2], W, Lf, tri), ...skin(0.6) }} />
      <div style={{ ...slopedFace([cx, top, z0], [0, 0, 1], [-W / 2, P, 0], D, Ls, tri), ...skin(0.7) }} />
      <div style={{ ...slopedFace([cx, top, z0], [0, 0, 1], [W / 2, P, 0], D, Ls, tri), ...skin(0.85) }} />
    </>
  );
}

/* ── Interior partition with a doorway cut into it ── */
function Partition({ len, H }: { len: number; H: number }) {
  const wall: React.CSSProperties = {
    position: 'absolute',
    background: 'linear-gradient(180deg, rgba(221,216,207,0.62), rgba(168,163,154,0.5))',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18)',
  };
  if (len < DOOR_W * 2.2) return <div style={{ ...wall, inset: 0 }} />;
  const doorL = (len - DOOR_W) / 2;
  const doorH = H * 0.62;
  return (
    <>
      <div style={{ ...wall, left: 0, top: 0, bottom: 0, width: `${doorL}px` }} />
      <div style={{ ...wall, right: 0, top: 0, bottom: 0, width: `${doorL}px` }} />
      <div style={{ ...wall, left: `${doorL}px`, width: `${DOOR_W}px`, top: 0, height: `${H - doorH}px` }} />
    </>
  );
}

interface FloorBlockProps {
  floor: Floor;
  index: number;
  isTop: boolean;   // topmost visible floor — its room labels show
  plan: boolean;    // floor-plan mode: low cut walls, light gridded slab, labelled room tiles
  pointedRoof: boolean; // top-floor pyramid gets an apex instead of a flat roof
  wallsPulse: number;
  wallLabel: string;
  extT: number;     // wall thickness, px
  intT: number;
  k: number;        // px per ft
  W: number;        // base bbox, ft
  D: number;
  showLabels: boolean;
  y: number;        // world y of this floor's slab
  rotX: number;
  rotY: number;
  above?: Rect[];   // footprint of the visible floor stacked on top — its uncovered part gets a roof
}

function FloorBlock({ floor, index, isTop, plan, pointedRoof, wallsPulse, wallLabel, extT, intT, k, W, D, showLabels, y, rotX, rotY, above }: FloorBlockProps) {
  const colors = pc(index);
  const H = plan ? PLAN_WALL_H : FLOOR_H;
  const grid = 5 * k; // 5-ft grid on the slab in plan mode
  // Pyramid storeys are ordinary floors on a smaller (stepped-in) footprint; only the top one gets a pointed cap
  const pyramid = floor.shape === 'pyramid' && !plan && floor.footprint.length > 0;
  const partH = H;
  const { ext, int, placed } = useMemo(() => planWalls(floor.footprint, floor.rooms, W, D), [floor.footprint, floor.rooms, W, D]);
  const door = index === 0 ? entrance(ext) : null;
  const windows = useMemo(() => windowsByRun(ext), [ext]);
  const labelRun = ext.filter(r => r.facing === 'front').reduce<ExtRun | null>((a, b) => (!a || b.len > a.len ? b : a), null);
  const terrace = useMemo(
    () => (above && !plan ? exposedRoof(floor.footprint, above, W, D) : null),
    [above, plan, floor.footprint, W, D],
  );

  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      transformStyle: 'preserve-3d', transformOrigin: '0 0',
      transform: `translate3d(0px,${y}px,0px)`,
      transition: 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)',
    }}>
      {/* Floor slab */}
      {floor.footprint.map((p, i) => (
        <div key={i} style={{
          ...flat(p.x * k, 0, p.z * k, p.w * k, p.d * k),
          background: plan
            ? `linear-gradient(rgba(28,28,30,0.16) 1px, transparent 1px) ${-p.x * k}px ${-p.z * k}px / ${grid}px ${grid}px,
               linear-gradient(90deg, rgba(28,28,30,0.16) 1px, transparent 1px) ${-p.x * k}px ${-p.z * k}px / ${grid}px ${grid}px,
               #dfe6ee`
            : `linear-gradient(135deg, #ddd7cd, #cbc4b8)`,
        }} />
      ))}

      {/* Room floors — exactly where the user placed them */}
      {placed.map(r => {
        const meta = roomMeta(r.type);
        return (
          <div key={r.id} title={`${r.name} · ${r.type} · ${r.area_sqft} sqft`} style={{
            ...flat(r.x! * k + 1, -0.6, r.z! * k + 1, Math.max(r.w * k - 2, 1), Math.max(r.d * k - 2, 1)),
            background: plan ? `${meta.color}b0` : `repeating-linear-gradient(45deg, ${meta.color}2a 0 6px, ${meta.color}1a 6px 12px)`,
            border: plan ? `2px solid ${meta.color}` : `1px solid ${meta.color}90`,
            borderRadius: '2px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
          }}>
            {plan ? (
              // Name painted on the floor, so the top view reads like a plan drawing
              <div style={{ textAlign: 'center', color: '#1c1c1e', lineHeight: 1.15, maxWidth: '100%', padding: '0 2px', fontSize: `${Math.max(5, Math.min(8, r.w * k * 0.09))}px` }}>
                <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{meta.symbol} {r.name}</div>
                <div style={{ fontWeight: 600, opacity: 0.8 }}>{r.w}×{r.d} ft</div>
              </div>
            ) : (
              <span style={{ fontSize: `${Math.min(18, Math.min(r.w, r.d) * k * 0.35)}px`, opacity: 0.55 }}>{meta.symbol}</span>
            )}
          </div>
        );
      })}

      {/* Interior partitions */}
      {int.map((p, i) => (
        <div key={i} style={p.axis === 'x' ? wallX(p.x * k, -partH, p.z * k, p.len * k, partH) : wallZ(p.x * k, -partH, p.z * k, p.len * k, partH)}>
          <Partition len={p.len * k} H={partH} />
        </div>
      ))}

      {/* Top pyramid storey: pointed cap instead of a flat terrace */}
      {pyramid && pointedRoof && <PyramidRoof fp={floor.footprint} k={k} H={H} colors={colors} />}

      {/* Exterior façades */}
      {ext.map((run, i) => (
        <FacadeRun key={i} run={run} k={k} H={H} colors={colors} windows={plan ? null : windows.get(run) ?? null} hasDoor={run === door}>
          {showLabels && !plan && run === labelRun && (
            <span style={{
              position: 'absolute', bottom: '3px', left: '8px',
              fontSize: '0.45rem', fontWeight: 800, letterSpacing: '0.12em', lineHeight: 1,
              color: colors.label, textShadow: `0 0 6px ${colors.label}80`, whiteSpace: 'nowrap',
            }}>
              FLOOR {String(floor.number).padStart(2, '0')} · {floor.rooms.length} {floor.rooms.length === 1 ? 'ROOM' : 'ROOMS'} · WALLS {wallLabel}
            </span>
          )}
          {run === door && !plan && (
            <div style={{
              position: 'absolute', bottom: 0, left: `${(run.len * k) / 2 - 10}px`, width: '20px', height: `${H * 0.62}px`,
              background: 'linear-gradient(180deg, #6b4423, #432910)',
              border: '1px solid #2a1a0a', borderRadius: '2px 2px 0 0',
            }}>
              <div style={{ position: 'absolute', right: '3px', top: '50%', width: '3px', height: '3px', borderRadius: '50%', background: '#d4a86a' }} />
            </div>
          )}
        </FacadeRun>
      ))}

      {/* Wall thickness — inner faces and caps (flash when the user changes it) */}
      {ext.map((run, i) => (
        <WallBody key={`we${i}`} axis={run.axis} x={run.x * k} z={run.z * k} len={run.len * k} t={extT} H={H}
          inward={run.facing === 'front' || run.facing === 'right' ? -1 : 1}
          cap="linear-gradient(90deg,#d6d3d1,#a8a29e)" face="linear-gradient(180deg,#e7e5e4,#c4c0bc)" pulse={wallsPulse} />
      ))}
      {int.map((p, i) => (
        <WallBody key={`wi${i}`} axis={p.axis} x={p.x * k} z={p.z * k} len={p.len * k} t={intT} H={H} inward={0}
          cap="#ddd8cf" face={null} pulse={wallsPulse} />
      ))}

      {/* Terrace over the part of this floor the floor above doesn't cover */}
      {terrace?.slabs.map((p, i) => (
        <div key={`ts${i}`} style={{
          ...flat(p.x * k, -H, p.z * k, p.w * k, p.d * k),
          background: 'linear-gradient(135deg, #b3ada3, #958e83)',
        }} />
      ))}
      {terrace?.edges.map((run, i) => (
        <div key={`tp${i}`} style={{
          ...(run.axis === 'x' ? wallX(run.x * k, -H - ROOF_H, run.z * k, run.len * k, ROOF_H) : wallZ(run.x * k, -H - ROOF_H, run.z * k, run.len * k, ROOF_H)),
          background: 'linear-gradient(180deg, #a8a297, #847d72)',
          filter: `brightness(${FACING_LIGHT[run.facing]})`,
        }} />
      ))}

      {/* Room labels — float above the walls of the floor you're looking at */}
      {showLabels && isTop && !plan && placed.map(r => {
        const meta = roomMeta(r.type);
        // A label is never wider than its room, so neighbours' labels don't run into each other
        const maxW = Math.max(34, r.w * k - 4);
        return (
          <div key={`lbl-${r.id}`} title={`${r.name} · ${r.w}×${r.d} ft · ${r.area_sqft} sq ft`} style={{
            ...billboard((r.x! + r.w / 2) * k, -H - 14, (r.z! + r.d / 2) * k, rotX, rotY),
            background: 'rgba(255,255,255,0.95)', boxShadow: '0 1px 3px rgba(60,52,44,0.18)',
            borderLeft: `3px solid ${meta.color}`,
            borderRadius: '4px', padding: '2px 5px',
            whiteSpace: 'nowrap', lineHeight: 1.15, maxWidth: `${maxW}px`, boxSizing: 'border-box',
          }}>
            <div style={{ fontSize: '8px', fontWeight: 800, color: '#2b2926', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {meta.symbol} {r.name}
            </div>
            {maxW >= 72 && (
              <div style={{ fontSize: '6.5px', fontWeight: 700, color: meta.color, letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.w}×{r.d} FT · {r.area_sqft} SQFT
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── Roof terrace with parapet, following the top floor's outline ── */
function RoofCap({ floor, k, W, D, y }: { floor: Floor; k: number; W: number; D: number; y: number }) {
  const { ext } = useMemo(() => planWalls(floor.footprint, [], W, D), [floor.footprint, W, D]);
  return (
    <div style={{
      position: 'absolute', left: 0, top: 0,
      transformStyle: 'preserve-3d', transformOrigin: '0 0',
      transform: `translate3d(0px,${y}px,0px)`,
      transition: 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)',
    }}>
      {floor.footprint.map((p, i) => (
        <div key={i} style={{
          ...flat(p.x * k, 0, p.z * k, p.w * k, p.d * k),
          background: 'linear-gradient(135deg, #b3ada3, #958e83)',
          boxShadow: 'inset 0 0 16px rgba(0,0,0,0.3)',
        }} />
      ))}
      {ext.map((run, i) => (
        <div key={i} style={{
          ...(run.axis === 'x' ? wallX(run.x * k, -ROOF_H, run.z * k, run.len * k, ROOF_H) : wallZ(run.x * k, -ROOF_H, run.z * k, run.len * k, ROOF_H)),
          background: 'linear-gradient(180deg, #a8a297, #847d72)',
          border: '1px solid rgba(0,0,0,0.3)',
          filter: `brightness(${FACING_LIGHT[run.facing]})`,
        }} />
      ))}
    </div>
  );
}

/* ── Parking & gardens, placed on the plot by the user ── */
const CAR_COLORS = ['#c98b7e', '#dedad2', '#8fa5c2', '#111827', '#a3a3a3', '#cfb07c'];

function CarBox({ x, z, along, color, k }: { x: number; z: number; along: 'x' | 'z'; color: string; k: number }) {
  // A ~6 × 11 ft car, nose pointing along `along`
  const [w, d] = along === 'z' ? [6 * k, 11 * k] : [11 * k, 6 * k];
  const h = 9;
  const side = (light: number): React.CSSProperties => ({ background: color, filter: `brightness(${light})` });
  return (
    <>
      <div style={{ ...flat(x, -h, z, w, d), ...side(1.15), borderRadius: '2px' }}>
        <div style={{ position: 'absolute', inset: '25%', background: 'rgba(37,40,44,0.75)', borderRadius: '1px' }} />
      </div>
      <div style={{ ...wallX(x, -h, z + d, w, h), ...side(0.9) }} />
      <div style={{ ...wallX(x, -h, z, w, h), ...side(0.6) }} />
      <div style={{ ...wallZ(x, -h, z, d, h), ...side(0.7) }} />
      <div style={{ ...wallZ(x + w, -h, z, d, h), ...side(0.8) }} />
    </>
  );
}

function SiteFeatureView({ f, k, ox, oz, rotX, rotY, showLabels }: {
  f: SiteFeature; k: number; ox: number; oz: number; rotX: number; rotY: number; showLabels: boolean;
}) {
  const x = (f.x - ox) * k, z = (f.z - oz) * k, w = f.w * k, d = f.d * k;
  const meta = SITE_META[f.type];
  const label = showLabels && (
    <div title={`${f.name} · ${f.area_sqft} sq ft`} style={{
      ...billboard(x + w / 2, -18, z + d / 2, rotX, rotY),
      background: 'rgba(255,255,255,0.95)', borderLeft: `2px solid ${meta.color}`, borderRadius: '3px', boxShadow: '0 1px 3px rgba(60,52,44,0.18)',
      padding: '2px 4px', whiteSpace: 'nowrap', fontSize: '6px', fontWeight: 700, color: '#3d3a35',
      maxWidth: `${Math.max(34, w - 4)}px`, boxSizing: 'border-box', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      {meta.symbol} {f.name} · {f.area_sqft} SQFT
    </div>
  );

  if (f.type === 'parking') {
    const along: 'x' | 'z' = f.w >= f.d ? 'x' : 'z';        // row of stalls runs along the long side
    const stallFt = 9;
    const stalls = Math.floor((along === 'x' ? f.w : f.d) / stallFt);
    const fitsCar = (along === 'x' ? f.d : f.w) >= 12;
    return (
      <>
        <div style={{
          ...flat(x, -0.4, z, w, d),
          background: along === 'x'
            ? `repeating-linear-gradient(90deg, #8e8981 0 ${stallFt * k - 1}px, #f4f1ec ${stallFt * k - 1}px ${stallFt * k}px), #8e8981`
            : `repeating-linear-gradient(180deg, #8e8981 0 ${stallFt * k - 1}px, #f4f1ec ${stallFt * k - 1}px ${stallFt * k}px), #8e8981`,
          border: `1px solid ${meta.color}`,
        }} />
        {fitsCar && Array.from({ length: Math.min(stalls, 6) }, (_, i) => (i % 3 === 2 ? null : (
          <CarBox key={i} k={k} along={along === 'x' ? 'z' : 'x'} color={CAR_COLORS[i % CAR_COLORS.length]}
            x={along === 'x' ? x + (i * stallFt + 1.5) * k : x + 1 * k}
            z={along === 'x' ? z + 1 * k : z + (i * stallFt + 1.5) * k} />
        )))}
        {label}
      </>
    );
  }

  // Garden: lawn + a few trees on a loose grid
  const cols = Math.max(1, Math.floor(f.w / 10)), rows = Math.max(1, Math.floor(f.d / 10));
  const trees: [number, number][] = [];
  for (let i = 0; i < cols && trees.length < 8; i++)
    for (let j = 0; j < rows && trees.length < 8; j++)
      if ((i + j) % 2 === 0) trees.push([x + ((i + 0.5) / cols) * w, z + ((j + 0.5) / rows) * d]);
  return (
    <>
      <div style={{
        ...flat(x, -0.4, z, w, d),
        background: 'radial-gradient(circle at 30% 30%, #8fa878, #5f7c4e)',
        border: `1px solid ${meta.color}90`, borderRadius: '4px',
      }} />
      {trees.map(([tx, tz], i) => (
        <div key={i} style={{ ...billboard(tx, -11, tz, rotX, rotY), fontSize: '22px', lineHeight: 1 }}>🌳</div>
      ))}
      {label}
    </>
  );
}

/** Deterministic pseudo-random scatter of trees outside the plot and road. */
function scatterTrees(GW: number, GD: number, plot: Rect, roadTop: number) {
  const spots: { x: number; y: number; r: number }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let attempts = 0; spots.length < 18 && attempts < 400; attempts++) {
    const x = rnd() * GW, y = rnd() * GD;
    if (x > plot.x - 8 && x < plot.x + plot.w + 8 && y > plot.z - 8 && y < plot.z + plot.d + 8) continue;
    if (y > roadTop - 12 && y < roadTop + ROAD_H + 12) continue;
    spots.push({ x, y, r: 8 + rnd() * 10 });
  }
  return spots;
}

/* ── Main component ── */
export function BuildingVisualizer() {
  const { state, dispatch } = useBuilding();
  const [zoom, setZoom] = useState(0.9);
  const [showLabels, setShowLabels] = useState(true);
  const [exploded, setExploded] = useState(false);
  const [adding, setAdding] = useState(false);
  // Why "Add Floor" was refused (e.g. not enough budget), shown as a popup
  const [blocked, setBlocked] = useState<{ title: string; message: string; budget: boolean } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  // Click-to-place in 3D; the design panel on the left arms it
  const { placing, setPlacing, focusFloor, setFocusFloor, setNotice, wallsPulse } = useDesign();
  const [hoverFt, setHoverFt] = useState<{ x: number; z: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const downPos = useRef({ x: 0, y: 0 });
  const [fps] = useState(144);

  // Full 360° rotation on both axes
  const [rotY, setRotY] = useState(-35);
  const [rotX, setRotX] = useState(-22);
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    downPos.current = { x: e.clientX, y: e.clientY };
    lastPos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setRotY(r => r + dx * 0.6);
    setRotX(r => Math.max(-90, Math.min(90, r - dy * 0.4)));
  }, []);

  const stopDrag = useCallback(() => { isDragging.current = false; }, []);

  const floors = [...state.floors].sort((a, b) => a.number - b.number);
  const totalFloors = floors.length;
  const shape = state.constraints?.shape || 'rectangle';
  const site = state.site;
  const unplacedCount = floors.reduce((n, f) => n + f.rooms.filter(r => r.x === null || r.z === null).length, 0);

  /* ── Scale & ground layout (px; world origin = building bbox back-left corner) ── */
  const Wft = Math.max(site.base_width_ft, 1);
  const Dft = Math.max(site.base_depth_ft, 1);
  const k = BASE_W / Wft;
  const BASE_D = Dft * k;
  const plot = { x: -site.building_x * k, z: -site.building_z * k, w: site.plot_width_ft * k, d: site.plot_depth_ft * k };
  const margin = Math.max(plot.w, plot.d, BASE_W) * 0.45;
  const ground = { x: plot.x - margin, z: plot.z - margin, w: plot.w + 2 * margin, d: plot.d + 2 * margin };
  const plotLocal = { x: margin, z: margin, w: plot.w, d: plot.d };   // plot in ground-local px
  const roadTop = margin + plot.d + 10;
  const trees = useMemo(
    () => scatterTrees(ground.w, ground.d, plotLocal, roadTop),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ground.w, ground.d, plotLocal.w, plotLocal.d, roadTop],
  );
  const groundFloor = floors[0];
  const doorRun = useMemo(
    () => (groundFloor ? entrance(planWalls(groundFloor.footprint, groundFloor.rooms, Wft, Dft).ext) : null),
    [groundFloor, Wft, Dft],
  );
  const door = doorRun ? { x: (doorRun.x + doorRun.len / 2) * k, z: doorRun.z * k } : { x: BASE_W / 2, z: BASE_D };
  const coords = siteCoords(state.district?.id ?? '', state.location);

  const handleAddFloor = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const res = await sendMessage('add a floor');
      if (res.updatedState) dispatch({ type: 'SET_STATE', payload: res.updatedState });
      if (res.structuralRisk !== undefined) dispatch({ type: 'SET_RISK', payload: res.structuralRisk });
      if (!res.updatedState && res.message_type !== 'success') {
        const budget = /budget/i.test(res.message);
        setBlocked({ title: budget ? 'Not enough money' : "Can't add a floor", message: res.message, budget });
      }
    } catch (err) {
      setBlocked({ title: "Can't add a floor", message: err instanceof Error ? err.message : 'Could not reach the backend.', budget: false });
    }
    finally { setAdding(false); }
  };

  const handleReset = async () => {
    try {
      const res = await sendMessage('reset building');
      if (res.updatedState) dispatch({ type: 'SET_STATE', payload: res.updatedState });
      if (res.structuralRisk !== undefined) dispatch({ type: 'SET_RISK', payload: res.structuralRisk });
    } catch { /* ignore */ }
  };

  const displayRotY = Math.round(((rotY % 360) + 360) % 360);
  const displayRotX = Math.round(rotX);
  const gap = exploded ? EXPLODE_GAP : 0;
  const floorY = (index: number) => -index * (FLOOR_H + gap);
  const buildingHeight = totalFloors * FLOOR_H + Math.max(0, totalFloors - 1) * gap + (exploded ? 0 : ROOF_H);
  const extT = (state.constraints.exteriorWallIn / 12) * k;
  const intT = (state.constraints.interiorWallIn / 12) * k;

  /* ── Screen → floor plan (ft) ──
     Un-project the cursor through the same transform chain the scene uses
     (perspective → scale → rotateX → rotateY → world offset) and intersect
     with the target floor's slab plane. */
  const screenToPlan = (clientX: number, clientY: number, floorIndex: number) => {
    const el = canvasRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const sx = clientX - (r.left + r.width / 2);
    const sy = clientY - (r.top + r.height / 2);
    const inv = new DOMMatrix()
      .scale(zoom, zoom, 1)
      .rotateAxisAngle(1, 0, 0, rotX)
      .rotateAxisAngle(0, 1, 0, rotY)
      .translate(-BASE_W / 2, buildingHeight / 2, -BASE_D / 2)
      .inverse();
    const at = (Z: number) => inv.transformPoint(new DOMPoint(sx * (PERSPECTIVE - Z) / PERSPECTIVE, sy * (PERSPECTIVE - Z) / PERSPECTIVE, Z));
    const a = at(0), b = at(200);
    if (Math.abs(b.y - a.y) < 1e-6) return null;
    const t = (floorY(floorIndex) - a.y) / (b.y - a.y);
    return { x: (a.x + t * (b.x - a.x)) / k, z: (a.z + t * (b.z - a.z)) / k };
  };

  const placeFloor = placing ? floors.find(f => f.number === placing.floor) : undefined;
  const ghost: Rect | null = placing && hoverFt ? {
    x: Math.max(0, Math.min(Wft - placing.w, Math.round(hoverFt.x - placing.w / 2))),
    z: Math.max(0, Math.min(Dft - placing.d, Math.round(hoverFt.z - placing.d / 2))),
    w: placing.w, d: placing.d,
  } : null;
  const ignoreId = placing?.kind === 'existing' ? placing.roomId : undefined;
  const ghostValid = !!ghost && !!placeFloor && insideUnion(ghost, placeFloor.footprint) &&
    !placeFloor.rooms.some(o => o.id !== ignoreId && o.x !== null && o.z !== null && overlaps(ghost, o as Rect));

  const onCanvasMove = (e: React.MouseEvent) => {
    if (placing) setHoverFt(screenToPlan(e.clientX, e.clientY, placing.floor - 1));
  };

  const onCanvasClick = async (e: React.MouseEvent) => {
    if (Math.hypot(e.clientX - downPos.current.x, e.clientY - downPos.current.y) > 5) return; // that was a rotate-drag
    if (!placing) {
      // Clicking the building opens the full-screen 3D view
      if (!expanded && totalFloors > 0) setExpanded(true);
      return;
    }
    if (!ghost) return;
    if (!ghostValid) {
      setNotice({ text: 'That spot is outside the floor or overlaps another room — move to a green spot or rotate it.', error: true });
      return;
    }
    const p = placing;
    try {
      const next = p.kind === 'new'
        ? await placeRoom(p.floor, p.type, ghost, p.name)
        : await updateRoom(p.roomId, { rect: ghost });
      dispatch({ type: 'SET_STATE', payload: next });
      setNotice({ text: `${p.name || p.type} placed on Floor ${p.floor} (${ghost.w} × ${ghost.d} ft at ${ghost.x}, ${ghost.z}).`, error: false });
      setPlacing(null);
      setHoverFt(null);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        if (placing) { setPlacing(null); setHoverFt(null); } else setExpanded(false);
      }
      if (placing && (e.key === 'r' || e.key === 'R')) setPlacing(p => p && { ...p, w: p.d, d: p.w });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [placing, setPlacing]);

  // Mouse wheel / trackpad pinch zooms the 3D only, never the page
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setZoom(z => Math.min(3, Math.max(0.3, z * factor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Floors above the one being worked on are cut away so its rooms are visible
  const cutAt = placing ? placing.floor : focusFloor;
  const visibleFloors = cutAt ? floors.filter(f => f.number <= cutAt) : floors;
  const topVisible = visibleFloors.length ? visibleFloors[visibleFloors.length - 1].number : 0;
  const isTopView = rotX <= -85;
  // Plan drawing (low walls, gridded slab) while placing or looking straight down
  const planMode = !!placing || isTopView;

  /** Look straight down at the plan (front/road side at the bottom) and fit it to the screen. */
  const goTopView = useCallback(() => {
    setRotX(-90);
    setRotY(0);
    const r = canvasRef.current?.getBoundingClientRect();
    if (r) setZoom(Math.min(3, Math.max(0.5, Math.min(r.width / (BASE_W * 1.2), r.height / (BASE_D * 1.2)))));
  }, [BASE_D]);
  const go3DView = () => { setRotX(-22); setRotY(-35); setZoom(0.9); };

  // Starting a placement switches to the top view, where spots are easiest to judge
  const placingActive = !!placing;
  useEffect(() => { if (placingActive) goTopView(); }, [placingActive, goTopView]);
  const floorShapes = [...new Set(floors.map(f => f.shape))];

  return (
    <div
      style={expanded
        ? { position: 'fixed', inset: 0, zIndex: 800, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f4f1ec' }
        : { flex: 1, display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', minWidth: 0 }}
      onMouseMove={onMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
    >
      {/* ── Metadata bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '1.1rem',
        padding: '0.5rem 1.25rem', whiteSpace: 'nowrap', overflow: 'hidden',
        background: 'rgba(60,52,44,0.14)',
        borderBottom: '1px solid var(--border-subtle)',
        fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.07em',
        color: 'var(--text-tertiary)', flexShrink: 0,
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#5c7d59', display: 'inline-block' }} />
          RENDER: VULKAN 3D
        </span>
        <span>COORDS: {coords[0].toFixed(4)}° N, {coords[1].toFixed(4)}° E</span>
        <span style={{ color: '#4f7d78' }}>ZOOM: {zoom.toFixed(1)}X</span>
        <span style={{ color: '#a57c3a' }}>ROT Y: {displayRotY}°</span>
        <span style={{ color: '#a57c3a' }}>ROT X: {displayRotX}°</span>
        <span style={{ color: '#5f5a80' }}>SHAPE: {(floorShapes.length ? floorShapes : [shape]).join(' + ').toUpperCase()}</span>
        <span style={{ color: '#77804e' }}>VIEW: {exploded ? 'EXPLODED' : 'STACKED'}</span>
        <span style={{ color: '#6b665e' }}>WALLS: {state.constraints.exteriorWallIn}″ / {state.constraints.interiorWallIn}″</span>
        <span style={{ marginLeft: 'auto' }}>FPS: {fps}</span>
      </div>

      {/* ── Main canvas ── */}
      <div
        style={{
          flex: 1, position: 'relative', overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: placing ? (ghostValid ? 'copy' : 'crosshair') : isDragging.current ? 'grabbing' : expanded ? 'grab' : 'zoom-in',
          userSelect: 'none',
          perspective: `${PERSPECTIVE}px`,
        }}
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onCanvasMove}
        onClick={onCanvasClick}
      >
        {/* Grid bg */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: `linear-gradient(rgba(60,52,44,0.06) 1px, transparent 1px),linear-gradient(90deg, rgba(60,52,44,0.06) 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }} />

        {/* Radial glow */}
        <div style={{
          position: 'absolute', width: '600px', height: '600px', borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(79,125,120,0.05) 0%, transparent 70%)',
          pointerEvents: 'none',
        }} />


        {/* Drag hint */}
        {totalFloors > 0 && (
          <div style={{
            // Above the toolbar, so the two never overlap in a narrow view
            position: 'absolute', bottom: '5.6rem', right: '1rem',
            fontSize: '0.6rem', letterSpacing: '0.1em', color: 'var(--text-tertiary)',
            fontWeight: 600, pointerEvents: 'none',
          }}>
            DRAG TO ROTATE • SCROLL TO ZOOM
          </div>
        )}

        {/* Top bar of overlays: one wrapping row, so they sit side by side (or wrap) instead of on top of each other */}
        <div onMouseDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} style={{
          position: 'absolute', top: '0.75rem', left: '0.75rem', right: '0.75rem', zIndex: 5,
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.45rem', pointerEvents: 'none',
        }}>
          {/* Full-screen 3D: hint to open, button to close */}
          {totalFloors > 0 && !placing && (
            <button onClick={() => setExpanded(v => !v)} title={expanded ? 'Exit full view (Esc)' : 'Full 3D view — or click the building'}
              style={{
                pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.7rem',
                background: 'rgba(255,255,255,0.85)', border: '1px solid var(--border-subtle)', borderRadius: '8px',
                color: 'var(--text-secondary)', fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
              }}>
              {expanded ? <><Minimize2 size={13} /> Exit full view</> : <><Maximize2 size={13} /> Full 3D view</>}
            </button>
          )}

          {/* Rooms added via chat still need the user to pick a spot */}
          {unplacedCount > 0 && (
            <button onClick={() => setPlanOpen(true)} title="Open the Floor Plan to place them" style={{
              pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap',
              background: 'rgba(165,124,58,0.12)', border: '1px solid rgba(165,124,58,0.45)', borderRadius: '20px',
              padding: '0.3rem 0.75rem', color: '#8c6a2f', fontSize: '0.66rem', fontWeight: 700, cursor: 'pointer',
            }}>
              <LayoutGrid size={13} /> {unplacedCount} room{unplacedCount === 1 ? '' : 's'} to place
            </button>
          )}

          {/* Which floor is shown, and a way back to the whole building */}
          {cutAt && !exploded && (cutAt < totalFloors || !planMode) && (
            <div style={{
              pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0.35rem 0.25rem 0.75rem',
              background: 'rgba(110,104,144,0.15)', border: '1px solid rgba(110,104,144,0.5)', borderRadius: '20px',
              color: '#4f4a6e', fontSize: '0.66rem', fontWeight: 700, whiteSpace: 'nowrap',
            }}>
              {cutAt < totalFloors ? `Floor ${cutAt} only` : `Floor ${cutAt} · roof hidden`}
              {!placing && (
                <button onClick={() => setFocusFloor(null)} style={{ background: 'rgba(60,52,44,0.12)', border: 'none', borderRadius: '12px', padding: '0.18rem 0.55rem', color: 'var(--text-primary)', fontSize: '0.64rem', fontWeight: 700, cursor: 'pointer' }}>
                  {cutAt < totalFloors ? 'Show all' : 'Show roof'}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Room legend */}
        {totalFloors > 0 && showLabels && !placing && (
          <div style={{
            position: 'absolute', bottom: '5.6rem', left: '1rem', zIndex: 4,
            display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: '0.15rem 0.6rem',
            background: 'rgba(255,255,255,0.75)', border: '1px solid var(--border-subtle)',
            borderRadius: '10px', padding: '0.5rem 0.65rem', pointerEvents: 'none',
          }}>
            {[...Object.entries(ROOM_META), ...Object.entries(SITE_META)].map(([type, meta]) => (
              <span key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.58rem', fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text-secondary)' }}>
                <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: `${meta.color}55`, border: `1px solid ${meta.color}` }} />
                {type.toUpperCase()}
              </span>
            ))}
          </div>
        )}

        {totalFloors === 0 ? (
          <EmptyState onAddFloor={handleAddFloor} adding={adding} />
        ) : (
          <div style={{
            position: 'relative', width: 0, height: 0,
            transformStyle: 'preserve-3d',
            transform: `scale(${zoom}) rotateX(${rotX}deg) rotateY(${rotY}deg)`,
            transition: isDragging.current ? 'none' : 'transform 0.3s ease',
          }}>
            {/* World origin: building footprint corner at ground level, centred on the pivot */}
            <div style={{
              position: 'absolute', left: 0, top: 0,
              transformStyle: 'preserve-3d', transformOrigin: '0 0',
              transform: `translate3d(${-BASE_W / 2}px,${buildingHeight / 2}px,${-BASE_D / 2}px)`,
              transition: 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)',
            }}>
              {/* Satellite-style ground */}
              <div style={{
                ...flat(ground.x, 1, ground.z, ground.w, ground.d),
                background: `
                  radial-gradient(circle at 28% 36%, rgba(150,168,128,0.35) 0%, transparent 32%),
                  radial-gradient(circle at 72% 62%, rgba(140,158,118,0.3) 0%, transparent 28%),
                  radial-gradient(circle at 48% 18%, rgba(178,168,138,0.25) 0%, transparent 38%),
                  radial-gradient(circle at 15% 80%, rgba(146,164,124,0.3) 0%, transparent 30%),
                  linear-gradient(135deg, #d3d6c3, #c3c8b0)
                `,
                boxShadow: 'inset 0 0 70px rgba(60,52,44,0.158)',
                overflow: 'hidden',
              }}>
                {/* Faint satellite grid / plot lines */}
                <div style={{
                  position: 'absolute', inset: 0,
                  backgroundImage: `linear-gradient(rgba(60,52,44,0.06) 1px, transparent 1px),linear-gradient(90deg, rgba(60,52,44,0.06) 1px, transparent 1px)`,
                  backgroundSize: '26px 26px',
                }} />
                {/* Highlight glow — spotlights the house against the terrain */}
                <div style={{
                  position: 'absolute', left: `${BASE_W / 2 - ground.x}px`, top: `${BASE_D / 2 - ground.z}px`,
                  width: `${BASE_W + 200}px`, height: `${BASE_D + 160}px`,
                  transform: 'translate(-50%,-50%)', borderRadius: '50%',
                  background: 'radial-gradient(ellipse, rgba(79,125,120,0.35) 0%, rgba(110,104,144,0.16) 42%, transparent 72%)',
                  animation: 'houseGlowPulse 3.5s ease-in-out infinite',
                }} />
                {/* Contact shadow directly under the house */}
                <div style={{
                  position: 'absolute', left: `${BASE_W / 2 - ground.x}px`, top: `${BASE_D / 2 - ground.z}px`,
                  width: `${BASE_W + 50}px`, height: `${BASE_D + 40}px`,
                  transform: 'translate(-50%,-50%)', borderRadius: '12%',
                  background: 'radial-gradient(ellipse, rgba(60,52,44,0.245) 0%, transparent 72%)',
                }} />
                {/* Road running past the front of the plot */}
                <div style={{
                  position: 'absolute', left: 0, top: `${roadTop}px`, width: '100%', height: `${ROAD_H}px`,
                  background: 'linear-gradient(90deg, rgba(118,113,106,0.85), rgba(142,137,129,0.92), rgba(118,113,106,0.85))',
                  boxShadow: '0 0 8px rgba(60,52,44,0.175)',
                }}>
                  <div style={{
                    position: 'absolute', top: '50%', left: 0, width: '100%', height: '1px',
                    background: 'repeating-linear-gradient(90deg, rgba(255,220,120,0.65) 0 8px, transparent 8px 16px)',
                  }} />
                </div>
                {/* Footpath from the entrance to the road */}
                <div style={{
                  position: 'absolute',
                  left: `${door.x - ground.x - 8}px`, width: '16px',
                  top: `${door.z - ground.z}px`, height: `${Math.max(0, roadTop - (door.z - ground.z))}px`,
                  background: 'repeating-linear-gradient(180deg, #a8a29e 0 6px, #8a8480 6px 7px)',
                  opacity: 0.85,
                }} />
                {/* Scattered vegetation */}
                {trees.map((t, i) => (
                  <div key={i} style={{
                    position: 'absolute', left: `${t.x}px`, top: `${t.y}px`,
                    width: `${t.r}px`, height: `${t.r}px`, borderRadius: '50%',
                    background: 'radial-gradient(circle at 35% 30%, #93ab7c, #61804f)',
                    boxShadow: '0 1px 3px rgba(60,52,44,0.175)',
                    transform: 'translate(-50%,-50%)',
                  }} />
                ))}
                {/* Plot boundary — the land the user configured */}
                <div style={{
                  position: 'absolute',
                  left: `${plotLocal.x}px`, top: `${plotLocal.z}px`,
                  width: `${plotLocal.w}px`, height: `${plotLocal.d}px`,
                  border: '1px dashed rgba(60,52,44,0.45)',
                  background: 'rgba(120,140,90,0.12)',
                }}>
                  <span style={{ position: 'absolute', right: '4px', bottom: '2px', fontSize: '7px', fontWeight: 700, color: 'rgba(60,52,44,0.55)', letterSpacing: '0.08em' }}>
                    PLOT {site.plot_width_ft}×{site.plot_depth_ft} FT
                  </span>
                </div>
              </div>

              {/* Parking & gardens */}
              {site.features.map(f => (
                <SiteFeatureView key={f.id} f={f} k={k} ox={site.building_x} oz={site.building_z}
                  rotX={rotX} rotY={rotY} showLabels={showLabels} />
              ))}

              {/* Building floors */}
              {visibleFloors.map(floor => (
                <FloorBlock
                  isTop={exploded || floor.number === topVisible}
                  plan={planMode && floor.number === topVisible}
                  pointedRoof={!exploded && !planMode && !cutAt && floor.number === totalFloors}
                  wallsPulse={wallsPulse}
                  wallLabel={`${state.constraints.exteriorWallIn}″`}
                  extT={extT}
                  intT={intT}
                  key={floor.id}
                  floor={floor}
                  index={floor.number - 1}
                  k={k}
                  W={Wft}
                  D={Dft}
                  showLabels={showLabels}
                  y={floorY(floor.number - 1)}
                  rotX={rotX}
                  rotY={rotY}
                  // Stacked view only: the floor on top leaves part of this one open to the sky
                  above={!exploded && !planMode ? visibleFloors.find(f => f.number === floor.number + 1)?.footprint : undefined}
                />
              ))}
              {!exploded && !planMode && !cutAt && floors[totalFloors - 1]?.shape !== 'pyramid' && <RoofCap floor={floors[totalFloors - 1]} k={k} W={Wft} D={Dft} y={floorY(totalFloors)} />}

              {/* Where the room will go — follows the cursor on the target floor */}
              {ghost && placing && (
                <div style={{ position: 'absolute', left: 0, top: 0, transformStyle: 'preserve-3d', transformOrigin: '0 0', transform: `translate3d(0px,${floorY(placing.floor - 1)}px,0px)`, pointerEvents: 'none' }}>
                  {(() => {
                    const c = ghostValid ? '16,185,129' : '239,68,68';
                    const gx = ghost.x * k, gz = ghost.z * k, gw = ghost.w * k, gd = ghost.d * k, gh = PLAN_WALL_H + 6;
                    const side: React.CSSProperties = { background: `rgba(${c},0.22)`, border: `1px solid rgba(${c},0.9)` };
                    return (
                      <>
                        <div style={{ ...flat(gx, -1.5, gz, gw, gd), background: `rgba(${c},0.45)`, border: `2px dashed rgb(${c})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span style={{ fontSize: `${Math.max(5, Math.min(8, gw * 0.12))}px`, fontWeight: 800, color: '#1c1c1e', textAlign: 'center' }}>
                            {ghost.w}×{ghost.d} ft
                          </span>
                        </div>
                        <div style={{ ...wallX(gx, -gh, gz + gd, gw, gh), ...side }} />
                        <div style={{ ...wallX(gx, -gh, gz, gw, gh), ...side }} />
                        <div style={{ ...wallZ(gx, -gh, gz, gd, gh), ...side }} />
                        <div style={{ ...wallZ(gx + gw, -gh, gz, gd, gh), ...side }} />
                        <div style={{ ...billboard(gx + gw / 2, -gh - 4, gz - 6, rotX, rotY), background: 'rgba(255,255,255,0.88)', border: `1px solid rgb(${c})`, borderRadius: '3px', padding: '1px 4px', fontSize: '5px', fontWeight: 700, color: '#3d3a35', whiteSpace: 'nowrap' }}>
                          {roomMeta(placing.type).symbol} {ghost.w}×{ghost.d} FT · {ghostValid ? 'CLICK TO PLACE' : 'BLOCKED'}
                        </div>
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
        )}

        <style>{`@keyframes houseGlowPulse { 0%, 100% { opacity: 0.75; } 50% { opacity: 1; } }
          @keyframes wallPulse { 0%, 100% { filter: none; } 50% { filter: drop-shadow(0 0 6px #a57c3a) brightness(1.4) sepia(1) saturate(4) hue-rotate(-15deg); } }`}</style>
      </div>

      {/* ── Labelled toolbar ── */}
      <div style={{
        position: 'absolute', bottom: '1.5rem', left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: '0.25rem',
        background: 'rgba(255,255,255,0.92)', border: '1px solid var(--border-subtle)',
        borderRadius: '16px', padding: '0.6rem 0.85rem', backdropFilter: 'blur(16px)',
        alignItems: 'flex-end',
      }}>
        <ToolBtn icon={<RotateCcw size={15} />} label="Reset" onClick={handleReset} />
        <ToolBtn icon={<ZoomIn size={15} />} label="Zoom In" onClick={() => setZoom(z => Math.min(z + 0.15, 3))} />
        <ToolBtn icon={<Plus size={18} />} label="Add Floor" accent loading={adding} onClick={handleAddFloor} />
        <ToolBtn icon={<LayoutGrid size={15} />} label="Floor Plan" onClick={() => setPlanOpen(true)} active={planOpen} />
        <ToolBtn icon={<MapPin size={15} />} label="Map" onClick={() => setMapOpen(true)} active={mapOpen} />
        <ToolBtn icon={<ZoomOut size={15} />} label="Zoom Out" onClick={() => setZoom(z => Math.max(z - 0.15, 0.3))} />
        <ToolBtn
          icon={showLabels ? <Eye size={15} /> : <EyeOff size={15} />}
          label="Labels" onClick={() => setShowLabels(v => !v)} active={showLabels}
        />
        <ToolBtn icon={<Layers size={15} />} label="Explode" onClick={() => setExploded(v => !v)} active={exploded} />
        <ToolBtn icon={isTopView ? <Box size={15} /> : <Square size={15} />} label={isTopView ? '3D View' : 'Top View'}
          onClick={() => (isTopView ? go3DView() : goTopView())} active={isTopView} />
      </div>

      {planOpen && <FloorPlanEditor onClose={() => setPlanOpen(false)} />}
      {mapOpen && <SiteMapView onClose={() => setMapOpen(false)} />}

      {blocked && (
        <div role="dialog" aria-modal="true" onClick={() => setBlocked(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(60,52,44,0.193)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 'min(380px, 100%)', background: '#ffffff', border: `1px solid ${blocked.budget ? '#b0604f66' : '#a57c3a66'}`, borderTop: `3px solid ${blocked.budget ? '#b0604f' : '#a57c3a'}`, borderRadius: '12px', padding: '1.1rem 1.2rem', boxShadow: '0 20px 50px rgba(60,52,44,0.21)' }}>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#2b2926', marginBottom: '0.5rem' }}>
              {blocked.budget ? '💸 ' : '⚠️ '}{blocked.title}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{blocked.message}</div>
            {blocked.budget && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: '0.6rem' }}>
                Raise the budget (e.g. type "set budget to 80 lakh" in chat) or remove a floor or room to free up money.
              </div>
            )}
            <button onClick={() => setBlocked(null)} autoFocus
              style={{ marginTop: '0.9rem', width: '100%', padding: '0.5rem', borderRadius: '8px', border: 'none', background: blocked.budget ? '#b0604f' : '#a57c3a', color: '#fff', fontWeight: 700, fontSize: '0.8rem', cursor: 'pointer' }}>
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Labelled toolbar button ── */
function ToolBtn({ icon, label, onClick, accent, active, loading }: {
  icon: React.ReactNode; label: string; onClick: () => void;
  accent?: boolean; active?: boolean; loading?: boolean;
}) {
  return (
    <button
      title={label} onClick={onClick} disabled={loading}
      style={{
        minWidth: '52px', padding: '0.4rem 0.4rem 0.3rem', borderRadius: '10px',
        background: accent ? '#5d6b80' : active ? 'rgba(79,125,120,0.15)' : 'rgba(60,52,44,0.048)',
        border: accent ? 'none' : active ? '1px solid rgba(79,125,120,0.3)' : '1px solid transparent',
        color: accent ? '#fff' : active ? '#4f7d78' : 'var(--text-secondary)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem',
        cursor: loading ? 'wait' : 'pointer', transition: 'all 0.15s', opacity: loading ? 0.7 : 1,
      }}
    >
      {loading ? <span style={{ fontSize: '0.7rem' }}>...</span> : icon}
      <span style={{ fontSize: '0.52rem', fontWeight: 700, letterSpacing: '0.04em', lineHeight: 1, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </button>
  );
}

/* ── Empty state ── */
function EmptyState({ onAddFloor, adding }: { onAddFloor: () => void; adding: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1rem', color: 'var(--text-tertiary)' }}>
      <div style={{ width: '80px', height: '80px', borderRadius: '16px', border: '2px dashed var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Layers size={32} color="var(--text-tertiary)" />
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>No floors yet</div>
        <div style={{ fontSize: '0.75rem' }}>Ask the AI to add a floor or click below</div>
      </div>
      <button
        onClick={onAddFloor} disabled={adding}
        style={{ background: '#5d6b80', border: 'none', borderRadius: '8px', padding: '0.6rem 1.25rem', color: '#fff', fontSize: '0.82rem', fontWeight: 600, cursor: adding ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '0.4rem' }}
      >
        <Plus size={14} />
        {adding ? 'Adding...' : 'Add First Floor'}
      </button>
    </div>
  );
}
