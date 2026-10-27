import type { DistrictData } from '../data/karnataka_db';
import type { Floor, Room, WallSide, WindowSpec } from '../context/BuildingContext';

/* ── Wall thickness suggestions ──
   Rules of thumb from Indian practice (IS 1905 masonry, IS 4326 earthquake
   detailing, NBC 2016). They're guidance for an early design, not a structural
   calculation — the backend only enforces the hard minimum (≥ 9″ at G+2 and up). */

export interface WallSuggestion {
  exteriorIn: number;
  interiorIn: number;
  reasons: string[];
}

export const WALL_OPTIONS_IN = [4.5, 6, 9, 13.5, 18];
export const inchToMm = (inch: number) => Math.round(inch * 25.4);

export function suggestWalls(district: DistrictData, floorCount: number): WallSuggestion {
  const reasons: string[] = [];
  let exterior = 9;
  const interior = 4.5;

  if (floorCount >= 3 && floorCount <= 4) {
    exterior = 13.5;
    reasons.push(`${floorCount} floors in load-bearing brick: use 13.5″ (345 mm) outer walls on the lower floors, 9″ above.`);
  } else if (floorCount > 4) {
    reasons.push(`${floorCount} floors: use an RCC frame (columns + beams); walls become 9″ infill and carry no load.`);
  } else {
    reasons.push('Up to G+1: 9″ (230 mm) brick outer walls are standard and load-bearing.');
  }

  if (district.seismic.zone !== 'II') {
    reasons.push(`Seismic Zone ${district.seismic.zone}: add RCC plinth, lintel and roof bands and vertical bars at corners (IS 4326) — thickness alone doesn't add earthquake strength.`);
  } else {
    reasons.push('Seismic Zone II: low hazard, but still tie walls with a lintel band.');
  }

  const climate = district.thermal.climateZone;
  if (climate === 'Hot-Dry' || climate === 'Composite') {
    if (exterior < 13.5) exterior = 13.5;
    reasons.push(`${climate} climate: thicker walls (13.5″, or 9″ cavity wall) store daytime heat and keep rooms cooler; target U ≤ ${district.thermal.uValueWall} W/m²K needs insulation either way.`);
  } else if (climate === 'Hot-Humid') {
    reasons.push('Hot-Humid climate: 9″ walls are enough — prioritise cross-ventilation (windows on opposite walls) and damp-proofing.');
  }

  if (district.wind.cycloneProbability === 'Moderate' || district.wind.cycloneProbability === 'High') {
    reasons.push(`Cyclone risk ${district.wind.cycloneProbability.toLowerCase()}: keep outer walls at least 9″ and anchor the roof to the walls.`);
  }

  reasons.push('Interior partitions: 4.5″ (115 mm) brick; use 9″ between bedrooms or next to the stairs for sound.');
  return { exteriorIn: exterior, interiorIn: interior, reasons };
}

/* ── Windows ── */

/** NBC 2016: openings ≥ 1/10 of floor area for habitable rooms; bathrooms need a ≥ 4 sq ft ventilator. */
export function suggestedGlazingSqft(room: Room): number {
  if (room.type === 'bathroom') return 4;
  if (room.type === 'store' || room.type === 'hallway') return Math.max(4, Math.round(room.area_sqft / 20));
  return Math.ceil(room.area_sqft / 10);
}

/** Feet of the room's `side` edge that are outside walls — mirrors backend exterior_length. */
export function exteriorLength(floor: Floor, room: Room, side: WallSide): number {
  if (room.x === null || room.z === null) return 0;
  const { x, z, w, d } = room as Room & { x: number; z: number };
  const inside = (cx: number, cz: number) =>
    floor.footprint.some(p => p.x <= cx && cx < p.x + p.w && p.z <= cz && cz < p.z + p.d);
  let n = 0;
  if (side === 'front' || side === 'back') {
    const cz = side === 'front' ? z + d : z - 1;
    for (let cx = x; cx < x + w; cx++) if (!inside(cx, cz)) n++;
  } else {
    const cx = side === 'right' ? x + w : x - 1;
    for (let cz = z; cz < z + d; cz++) if (!inside(cx, cz)) n++;
  }
  return n;
}

/** A sensible starting point offered to the user for one wall (not drawn until they add it). */
export function suggestedWindows(room: Room, side: WallSide, lengthFt: number): WindowSpec {
  if (room.type === 'bathroom') return { side, count: 1, width_ft: 2, height_ft: 2 };
  if (room.type === 'store' || room.type === 'hallway') return { side, count: lengthFt >= 5 ? 1 : 0, width_ft: 3, height_ft: 3 };
  const width = 4;
  return { side, count: Math.max(0, Math.min(2, Math.floor((lengthFt - 1) / (width + 2)))), width_ft: width, height_ft: 4.5 };
}

/** The windows the user added on this side, if any — only these are drawn. */
export const userWindows = (room: Room, side: WallSide): WindowSpec | undefined =>
  room.windows.find(w => w.side === side);
