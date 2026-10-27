import type { Rect } from '../context/BuildingContext';

/* ── Room type metadata (shared by the 3D view and the floor-plan editor) ── */
export const ROOM_META: Record<string, { symbol: string; color: string; label: string; suggestedSqft: number }> = {
  bedroom:  { symbol: '🛏', color: '#3f6b66', label: 'BED',  suggestedSqft: 160 },
  bathroom: { symbol: '🚿', color: '#57729a', label: 'BATH', suggestedSqft: 50 },
  kitchen:  { symbol: '🍳', color: '#8c6a2f', label: 'KIT',  suggestedSqft: 100 },
  living:   { symbol: '🛋', color: '#9e5e70', label: 'LIV',  suggestedSqft: 220 },
  dining:   { symbol: '🍽', color: '#9a5040', label: 'DIN',  suggestedSqft: 120 },
  hallway:  { symbol: '🚪', color: '#77804e', label: 'HALL', suggestedSqft: 60 },
  office:   { symbol: '💼', color: '#5f5a80', label: 'OFC',  suggestedSqft: 120 },
  store:    { symbol: '📦', color: '#a8714a', label: 'STR',  suggestedSqft: 40 },
  general:  { symbol: '◻', color: '#6b665e', label: 'RM',   suggestedSqft: 120 },
};
export const roomMeta = (type: string) => ROOM_META[type] ?? ROOM_META.general;

export const SITE_META: Record<'parking' | 'garden', { symbol: string; color: string; label: string; suggestedSqft: number }> = {
  parking: { symbol: '🚗', color: '#6b665e', label: 'PARKING', suggestedSqft: 180 },
  garden:  { symbol: '🌳', color: '#4ade80', label: 'GARDEN',  suggestedSqft: 200 },
};

/** Near-square width × depth (ft) covering at least `area` sq ft — mirrors backend default_dims. */
export function defaultDims(area: number): { w: number; d: number } {
  const w = Math.max(1, Math.round(Math.sqrt(area)));
  return { w, d: Math.max(1, Math.ceil(area / w)) };
}

export const MIN_SIDE_FT = 4;

export const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d;

/** True if every 1-ft cell of `r` lies inside one of `parts` — mirrors backend inside_union. */
export function insideUnion(r: Rect, parts: Rect[]): boolean {
  for (let cx = r.x; cx < r.x + r.w; cx++) {
    for (let cz = r.z; cz < r.z + r.d; cz++) {
      if (!parts.some(p => p.x <= cx && cx < p.x + p.w && p.z <= cz && cz < p.z + p.d)) return false;
    }
  }
  return true;
}
