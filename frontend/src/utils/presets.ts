/* ── Home presets (1BHK, 2BHK …) and room-size suggestions ──
   Sizes follow common Indian residential practice (NBC 2016 minimums:
   habitable room ≥ 95 sq ft, kitchen ≥ 50, bathroom ≥ 30); "standard" is a
   comfortable mid-range value the user can change. */

export interface PresetRoom { type: string; name?: string }
export interface Preset { id: string; label: string; emoji: string; color: string; desc: string; rooms: PresetRoom[] }

// Only distinctive rooms get a name; the backend numbers the rest per type
// (Bedroom 2, Bathroom 1 …), so adding a preset to a floor that already has
// rooms never produces duplicate names.
const bed = (n: number): PresetRoom[] =>
  Array.from({ length: n }, (_, i) => (i === 0 ? { type: 'bedroom', name: 'Master Bedroom' } : { type: 'bedroom' }));
const bath = (n: number): PresetRoom[] => Array.from({ length: n }, () => ({ type: 'bathroom' }));

export const PRESETS: Preset[] = [
  { id: '1bhk', label: '1BHK', emoji: '🏠', color: '#6e6890', desc: '1 bed · hall · kitchen · bath',
    rooms: [...bed(1), { type: 'living', name: 'Hall' }, { type: 'kitchen', name: 'Kitchen' }, ...bath(1)] },
  { id: '2bhk', label: '2BHK', emoji: '🏡', color: '#4f7d78', desc: '2 bed · hall · kitchen · 2 bath',
    rooms: [...bed(2), { type: 'living', name: 'Hall' }, { type: 'kitchen', name: 'Kitchen' }, ...bath(2)] },
  { id: '3bhk', label: '3BHK', emoji: '🏗', color: '#5c7d59', desc: '3 bed · hall · kitchen · dining · 2 bath',
    rooms: [...bed(3), { type: 'living', name: 'Hall' }, { type: 'kitchen', name: 'Kitchen' }, { type: 'dining', name: 'Dining' }, ...bath(2)] },
  { id: '4bhk', label: '4BHK', emoji: '🏢', color: '#6e6890', desc: '4 bed · hall · kitchen · dining · 3 bath',
    rooms: [...bed(4), { type: 'living', name: 'Hall' }, { type: 'kitchen', name: 'Kitchen' }, { type: 'dining', name: 'Dining' }, ...bath(3)] },
  { id: 'studio', label: 'Studio', emoji: '🛖', color: '#9e5e70', desc: 'open room · kitchenette · bath',
    rooms: [{ type: 'living', name: 'Studio Room' }, { type: 'kitchen', name: 'Kitchenette' }, ...bath(1)] },
  { id: 'office', label: 'Office Floor', emoji: '💼', color: '#a8714a', desc: '4 offices · 1 bath · store',
    rooms: [...[1, 2, 3, 4].map((): PresetRoom => ({ type: 'office' })), ...bath(1), { type: 'store' }] },
];

/** Standard size (sq ft) per room type; the first bedroom of a home is the master. */
export const STANDARD_SQFT: Record<string, number> = {
  bedroom: 140, bathroom: 45, kitchen: 90, living: 200, dining: 110,
  hallway: 60, office: 120, store: 40, general: 120,
};
const MIN_SQFT: Record<string, number> = { bedroom: 95, bathroom: 30, kitchen: 50, living: 120, dining: 80, hallway: 30, office: 80, store: 20, general: 60 };

export function suggestedSqft(room: PresetRoom): number {
  return room.name === 'Master Bedroom' ? 160 : STANDARD_SQFT[room.type] ?? 120;
}

/** Small / standard / large choices offered beside the sq-ft box. */
export function sizeChoices(type: string): { label: string; sqft: number }[] {
  const std = STANDARD_SQFT[type] ?? 120;
  return [
    { label: 'Small', sqft: Math.max(MIN_SQFT[type] ?? 30, Math.round(std * 0.8 / 5) * 5) },
    { label: 'Standard', sqft: std },
    { label: 'Large', sqft: Math.round(std * 1.3 / 5) * 5 },
  ];
}

export const minSqft = (type: string) => MIN_SQFT[type] ?? 30;

/**
 * Suggested sizes for a set of rooms that fit in `freeSqft`: standard sizes,
 * shrunk proportionally (never below the minimum) when the floor is tight.
 * Leaves ~15% for walls and passages, which also gives "Arrange for me" room to fit everything.
 */
export function fitSizes(rooms: PresetRoom[], freeSqft: number): number[] {
  const wanted = rooms.map(suggestedSqft);
  const total = wanted.reduce((a, b) => a + b, 0);
  const budget = freeSqft * 0.85;
  if (total <= budget) return wanted;
  const scale = budget / total;
  return rooms.map((r, i) => Math.max(minSqft(r.type), Math.floor(wanted[i] * scale / 5) * 5));
}
