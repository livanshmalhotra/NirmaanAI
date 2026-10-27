import React, { createContext, useContext, useEffect, useReducer, type ReactNode } from 'react';
import { fetchBuildingState, onServerState, type Workspace } from '../services/api';
import { getDefaultDistrict, getDistrictById, type DistrictData } from '../data/karnataka_db';

// --- Types ---
/** Axis-aligned rectangle in feet. */
export interface Rect {
  x: number;
  z: number;
  w: number;
  d: number;
}

export type WallSide = 'front' | 'back' | 'left' | 'right';

/** Windows the user asked for on one outside wall of a room (front = road side). */
export interface WindowSpec {
  side: WallSide;
  count: number;
  width_ft: number;
  height_ft: number;
}

export interface Room {
  id: string;
  name: string;
  type: string;
  area_sqft: number;
  /** Spot picked by the user on the floor plan (ft, building bbox frame); null until placed. */
  x: number | null;
  z: number | null;
  w: number;
  d: number;
  /** Sides without an entry get default windows; count 0 = no windows. */
  windows: WindowSpec[];
}

export interface Floor {
  id: string;
  number: number;
  shape: string;
  rooms: Room[];
  footprint: Rect[];
  area_sqft: number;
}

export interface SiteFeature extends Rect {
  id: string;
  name: string;
  type: 'parking' | 'garden';
  area_sqft: number;
}

export interface SiteLayout {
  plot_width_ft: number;
  plot_depth_ft: number;
  building_x: number;
  building_z: number;
  base_width_ft: number;
  base_depth_ft: number;
  footprint: Rect[];
  features: SiteFeature[];
}

export interface Budget {
  total: number;
  used: number;
  remaining: number;
  costPerFloor: number;
  costPerRoom: number;
  costPerSqft: number;
}

export interface Constraints {
  maxFloors: number;
  maxRoomsPerFloor: number;
  minRoomsPerFloor: number;
  defaultRoomSqft: number;
  shape: string;
  floorAreaSqft: number;
  plotAreaSqft: number;
  exteriorWallIn: number;
  interiorWallIn: number;
  district_id?: string;
  /** KPWD rates exclude GST; the estimate adds 18% only when this is on */
  includeGst?: boolean;
}

/** Where the building is — from GPS, a map click, typed coordinates or a place name. */
export interface SiteLocation {
  lat: number;
  lng: number;
  address: string;
  district_id: string;
  /** District name as the geocoder reported it (differs from ours when we fell back to the nearest) */
  reported_district: string;
  in_karnataka: boolean;
  source: 'gps' | 'search' | 'map' | 'coords';
  approximated: boolean;
  offline: boolean;
  /** Compass bearing the front (road side) faces: 0 = north, 90 = east */
  heading_deg?: number;
}

export interface BuildingState {
  floors: Floor[];
  budget: Budget;
  constraints: Constraints;
  site: SiteLayout;
  location?: SiteLocation | null;
  history: Array<{ action: string; timestamp: string; details: string }>;
  district: DistrictData;
  structuralRisk: number | null;
}

// --- Initial State ---
const INITIAL_BUDGET = 5000000; // 50 Lakh

const initialState: BuildingState = {
  floors: [],
  budget: {
    total: INITIAL_BUDGET,
    used: 0,
    remaining: INITIAL_BUDGET,
    costPerFloor: 500000, // 5 Lakh
    costPerRoom: 100000,  // 1 Lakh
    costPerSqft: 200,
  },
  constraints: {
    maxFloors: 10,
    maxRoomsPerFloor: 12,
    minRoomsPerFloor: 1,
    defaultRoomSqft: 500,
    shape: 'rectangle',
    floorAreaSqft: 1200,
    plotAreaSqft: 2400,
    exteriorWallIn: 9,
    interiorWallIn: 4.5,
  },
  site: {
    plot_width_ft: 0, plot_depth_ft: 0, building_x: 0, building_z: 0,
    base_width_ft: 0, base_depth_ft: 0, footprint: [], features: [],
  },
  history: [],
  district: getDefaultDistrict(),
  structuralRisk: null,
};

// --- Actions ---
export type BuildingAction =
  | { type: 'SET_STATE'; payload: BuildingState }
  | { type: 'SET_DISTRICT'; payload: DistrictData }
  | { type: 'SET_RISK'; payload: number | null }
  | { type: 'RESET' };

/** Fill fields an older backend may not send, so the views never crash on them. */
function normalize(p: BuildingState): BuildingState {
  return {
    ...p,
    constraints: { ...initialState.constraints, ...p.constraints },
    site: { ...initialState.site, ...p.site },
    floors: (p.floors ?? []).map(f => ({
      ...f,
      shape: f.shape ?? p.constraints?.shape ?? 'rectangle',
      footprint: f.footprint ?? [],
      area_sqft: f.area_sqft ?? 0,
      rooms: (f.rooms ?? []).map(r => ({ ...r, x: r.x ?? null, z: r.z ?? null, windows: r.windows ?? [] })),
    })),
  };
}

// --- Reducer ---
function buildingReducer(state: BuildingState, action: BuildingAction): BuildingState {
  switch (action.type) {
    case 'SET_STATE': {
      // Backend payloads carry only district_id (it changes when the site location is set);
      // map it to the full district record, and keep the risk score from the response
      const serverDistrict = getDistrictById(action.payload.constraints?.district_id ?? '');
      return {
        ...normalize(action.payload),
        district: action.payload.district ?? serverDistrict ?? state.district,
        structuralRisk: state.structuralRisk,
      };
    }
    case 'SET_DISTRICT':
      return { ...state, district: action.payload };
    case 'SET_RISK':
      return { ...state, structuralRisk: action.payload };
    case 'RESET':
      return {
        ...initialState,
        district: state.district,
        structuralRisk: null,
        budget: {
          ...initialState.budget,
          total: state.budget.total,
          remaining: state.budget.total,
          costPerSqft: state.budget.costPerSqft,
        },
        constraints: {
          ...initialState.constraints,
          defaultRoomSqft: state.constraints.defaultRoomSqft,
          shape: state.constraints.shape,
          floorAreaSqft: state.constraints.floorAreaSqft,
          plotAreaSqft: state.constraints.plotAreaSqft,
          exteriorWallIn: state.constraints.exteriorWallIn,
          interiorWallIn: state.constraints.interiorWallIn,
          district_id: state.constraints.district_id,
          includeGst: state.constraints.includeGst,
        },
        site: { ...state.site, features: [] },
        location: state.location,
        history: [{ action: 'reset', timestamp: new Date().toISOString(), details: 'Building reset to empty state' }]
      };
    default:
      return state;
  }
}

// --- Context ---
const BuildingContext = createContext<{
  state: BuildingState;
  dispatch: React.Dispatch<BuildingAction>;
} | undefined>(undefined);

/**
 * Holds one building for the components inside it. The app has one for the
 * user's building; the Pro design generator nests a second one, with
 * workspace="draft", around the editor showing the generated design.
 */
export function BuildingProvider({ children, workspace = 'main', initial }: {
  children: ReactNode; workspace?: Workspace; initial?: BuildingState;
}) {
  const [state, dispatch] = useReducer(buildingReducer, initial ? buildingReducer(initialState, { type: 'SET_STATE', payload: initial }) : initialState);

  // Stay in step with the server: adopt its state when a request finds the page
  // stale, and re-check whenever the user comes back to the tab.
  useEffect(() => {
    const off = onServerState(s => dispatch({ type: 'SET_STATE', payload: s }), workspace);
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        fetchBuildingState(workspace).then(s => dispatch({ type: 'SET_STATE', payload: s })).catch(() => { /* backend offline */ });
      }
    };
    document.addEventListener('visibilitychange', refresh);
    return () => { off(); document.removeEventListener('visibilitychange', refresh); };
  }, [workspace]);

  return (
    <BuildingContext.Provider value={{ state, dispatch }}>
      {children}
    </BuildingContext.Provider>
  );
}

export function useBuilding() {
  const context = useContext(BuildingContext);
  if (context === undefined) {
    throw new Error('useBuilding must be used within a BuildingProvider');
  }
  return context;
}
