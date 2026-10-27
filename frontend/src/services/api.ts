/**
 * Thin HTTP client for the AI Architect Assistant backend.
 * All network calls go through this module.
 */
import { API_BASE_URL } from '../utils/constants';
import type { BuildingState, Rect, WindowSpec, SiteLocation } from '../context/BuildingContext';

// ── Response shapes ──────────────────────────────────────────────────────────

export interface MaterialsCostBreakdown {
  concrete: number;
  steel: number;
  glass: number;
  total: number;
  /** "kpwd_sr" (Schedule of Rates bill of quantities), "ml_model" or "formula" */
  source?: string;
}

/** One priced line of the KPWD Schedule of Rates bill of quantities. */
export interface BOQLine {
  key: string;
  label: string;
  category: 'material' | 'labour' | 'add_on' | 'fitting' | 'regional' | 'tax';
  qty: number;
  unit: string;
  rate: number;
  amount: number;
  ref: string;
  page: string;
  /** verified = checked against KPWD Vol 2; placeholder = awaiting a Vol 1 / quarterly rate */
  status: 'verified' | 'placeholder' | 'interim' | 'derived';
}

export interface BOQBreakdown {
  district_id: string;
  plinth_area_m2: number;
  floors: number;
  relation_set: 'single' | 'double' | 'none';
  approximate: boolean;
  lines: BOQLine[];
  subtotal: number;
  regional_pct: number;
  regional_status: string;
  include_gst: boolean;
  total: number;
  placeholders_used: number;
  notes: string[];
}

export interface HistoryEntry {
  action: string;
  timestamp: string;
  details: string;
}

export interface AnimationHint {
  type: string;
  target: Record<string, unknown>;
}

export type MessageType = 'success' | 'error' | 'warning' | 'info';

export interface ChatResponse {
  message: string;
  message_type: MessageType;
  updatedState: BuildingState | null;
  suggestions: string[];
  actionLog: HistoryEntry | null;
  animationHint: AnimationHint | null;
  costBreakdown: MaterialsCostBreakdown | null;
  structuralRisk: number | null;
  /** Something only the browser can do, e.g. "request_geolocation" */
  clientAction?: string | null;
}

export interface ModelInfo {
  ml_dependencies_available: boolean;
  districts_loaded: number;
  cost_model: { loaded: boolean; meta: Record<string, unknown> | null };
  risk_model: { loaded: boolean; meta: Record<string, unknown> | null };
}

// ── Workspaces ───────────────────────────────────────────────────────────────
// "main" is the user's building; "draft" is a design the AI generator proposed.
// While the draft is open in the editor every request goes to it (the backend
// reads the X-Workspace header), so the normal editing tools work on it.

export type Workspace = 'main' | 'draft';
let activeWorkspace: Workspace = 'main';

export function setApiWorkspace(workspace: Workspace): void {
  activeWorkspace = workspace;
}

export function getApiWorkspace(): Workspace {
  return activeWorkspace;
}

// ── Keeping the page in step with the server ─────────────────────────────────
// If the server says a floor/room doesn't exist, the page is showing a stale
// building (e.g. the backend restarted). Listeners get the server's real state.

type StateListener = (state: BuildingState) => void;
const stateListeners: Record<Workspace, Set<StateListener>> = { main: new Set(), draft: new Set() };

export function onServerState(listener: StateListener, workspace: Workspace = 'main'): () => void {
  stateListeners[workspace].add(listener);
  return () => { stateListeners[workspace].delete(listener); };
}

async function resyncFromServer(workspace: Workspace): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/state`, { headers: { 'X-Workspace': workspace } });
    if (!res.ok) return false;
    const state = (await res.json()) as BuildingState;
    stateListeners[workspace].forEach(l => l(state));
    return true;
  } catch {
    return false;
  }
}

// ── Internal fetch helper ────────────────────────────────────────────────────

async function request<T>(path: string, options?: RequestInit, workspace: Workspace = activeWorkspace): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'X-Workspace': workspace, ...options?.headers },
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      // ignore parse errors
    }
    if (res.status === 404 || /doesn't exist|not found/i.test(detail)) {
      if (await resyncFromServer(workspace)) {
        detail += ' Your screen was out of date, so it has been refreshed from the server — please try again.';
      }
    }
    throw new Error(detail);
  }

  return res.json() as Promise<T>;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Fetch the current authoritative building state (of the given workspace) from the server. */
export async function fetchBuildingState(workspace: Workspace = activeWorkspace): Promise<BuildingState> {
  return request<BuildingState>('/api/state', undefined, workspace);
}

/**
 * Send a natural language message to the orchestrator.
 * Returns the full ChatResponse including the (possibly) updated state.
 */
export async function sendMessage(message: string): Promise<ChatResponse> {
  return request<ChatResponse>('/api/chat', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
}

/** Hard-reset the building on the server and return the fresh state. */
export async function resetBuilding(): Promise<BuildingState> {
  return request<BuildingState>('/api/reset', { method: 'POST' });
}

/** Health check — resolves true if the backend is reachable. */
export async function checkHealth(): Promise<boolean> {
  try {
    await request('/health');
    return true;
  } catch {
    return false;
  }
}

/** Verifies whether the trained cost/risk models are loaded and serving. */
export async function getModelInfo(): Promise<ModelInfo> {
  return request<ModelInfo>('/api/model-info');
}

// ── Floor-plan editor: user-placed rooms & site features ─────────────────────

export async function placeRoom(floorNumber: number, type: string, rect: Rect, name?: string): Promise<BuildingState> {
  return request<BuildingState>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify({ floor_number: floorNumber, type, name: name || null, ...rect }),
  });
}

/** Move / resize / first-time place a room, or rename it. */
export async function updateRoom(roomId: string, changes: { rect?: Rect; name?: string }): Promise<BuildingState> {
  return request<BuildingState>(`/api/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(changes) });
}

export async function deleteRoom(roomId: string): Promise<BuildingState> {
  return request<BuildingState>(`/api/rooms/${roomId}`, { method: 'DELETE' });
}

export async function addSiteFeature(type: 'parking' | 'garden', rect: Rect, name?: string): Promise<BuildingState> {
  return request<BuildingState>('/api/site-features', {
    method: 'POST',
    body: JSON.stringify({ type, name: name || null, ...rect }),
  });
}

export async function updateSiteFeature(featureId: string, rect: Rect): Promise<BuildingState> {
  return request<BuildingState>(`/api/site-features/${featureId}`, { method: 'PATCH', body: JSON.stringify(rect) });
}

export async function deleteSiteFeature(featureId: string): Promise<BuildingState> {
  return request<BuildingState>(`/api/site-features/${featureId}`, { method: 'DELETE' });
}

/** Delete one floor with its rooms; the floors above move down a level. */
export async function deleteFloor(floorNumber: number): Promise<BuildingState> {
  return request<BuildingState>(`/api/floors/${floorNumber}`, { method: 'DELETE' });
}

/** Give one floor its own shape; the backend rejects shapes that overhang the floor below. */
export async function setFloorShape(floorNumber: number, shape: string): Promise<BuildingState> {
  return request<BuildingState>(`/api/floors/${floorNumber}`, { method: 'PATCH', body: JSON.stringify({ shape }) });
}

/** Set the windows on one outside wall of a room (count 0 removes them). */
export async function setRoomWindows(roomId: string, spec: WindowSpec): Promise<BuildingState> {
  return request<BuildingState>(`/api/rooms/${roomId}/windows`, { method: 'PUT', body: JSON.stringify(spec) });
}

export async function setWalls(exteriorIn: number, interiorIn: number): Promise<BuildingState> {
  return request<BuildingState>('/api/walls', {
    method: 'PUT',
    body: JSON.stringify({ exterior_in: exteriorIn, interior_in: interiorIn }),
  });
}

/** Add several rooms to one floor — optionally laid out as a starting point the user can move. */
export async function addRoomsBatch(
  floorNumber: number,
  rooms: { type: string; area_sqft: number; name?: string }[],
  arrange: boolean,
): Promise<BuildingState> {
  return request<BuildingState>('/api/rooms/batch', {
    method: 'POST',
    body: JSON.stringify({ floor_number: floorNumber, rooms, arrange }),
  });
}

// ── Site location & KPWD Schedule of Rates costing ───────────────────────────

/** Set where the building is from coordinates (GPS / map) or a place name. */
export async function setLocation(
  loc: { lat: number; lng: number; source: SiteLocation['source'] } | { query: string },
): Promise<ChatResponse> {
  return request<ChatResponse>('/api/location', { method: 'POST', body: JSON.stringify(loc) });
}

/** Turn the building on its site (compass bearing its front faces). */
export async function setHeading(headingDeg: number): Promise<BuildingState> {
  return request<BuildingState>('/api/location/heading', { method: 'PUT', body: JSON.stringify({ heading_deg: headingDeg }) });
}

/** Ask the browser for the user's position (needs their permission). */
export function getBrowserPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('This browser does not support location. Type a place instead, e.g. "build it in Mysuru".'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(new Error(err.code === err.PERMISSION_DENIED
        ? 'Location access was blocked. Type a place instead, e.g. "build it in Mysuru".'
        : 'Could not get your location. Type a place instead, e.g. "build it in Mysuru".')),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  });
}

/** The building priced line by line from the KPWD Schedule of Rates. */
export async function getBoq(): Promise<BOQBreakdown> {
  return request<BOQBreakdown>('/api/estimate/boq');
}

/** Include or exclude 18% GST (KPWD rates exclude it). */
export async function setIncludeGst(include: boolean): Promise<BuildingState> {
  return request<BuildingState>('/api/estimate/gst', { method: 'PUT', body: JSON.stringify({ include }) });
}

// ── Seismic analysis (IS 1893 (Part 1):2016, backend/services/seismic_analysis.py) ──

export type SoilType = 'I' | 'II' | 'III';

export interface SeismicDirection {
  direction: string;
  d_m: number;
  Ta_s: number;
  Ta_rule: string;
  Sa_g: number;
  Ah: number;
  Ah_min: number;
  min_governs: boolean;
  VB_kN: number;
  VB_percent_W: number;
  overturning_kNm: number;
  forces: { level: number; Q_kN: number; V_kN: number }[];
}

export interface SeismicAnalysis {
  error?: string;
  soil: SoilType;
  soil_name: string;
  frame: 'OMRF' | 'SMRF';
  R: number;
  I: number;
  infill: boolean;
  height_m: number;
  storey_height_m: number;
  W_kN: number;
  levels: { level: number; h_m: number; W_kN: number; dead_kN: number; imposed_kN: number }[];
  storeys: { floor: number; area_m2: number; ext_wall_m: number; int_wall_m: number; walls_kN: number; slab_kN: number }[];
  directions: SeismicDirection[];
  governing: string;
  checks: { ok: boolean; rule: string; detail: string }[];
  inputs: { name: string; value: string | number; source: string }[];
  assumptions: string[];
}

export interface SeismicReport {
  site: { lat: number; lon: number; label: string; source: string };
  zone: { zone: string | null; Z: number | null; basis: string[] };
  soil_texture: { available: boolean; reason: string; clay?: number; sand?: number; silt?: number; depth?: string; suggested?: SoilType };
  soil_used: SoilType | null;
  soil_source: string;
  earthquakes: {
    radius_km: number;
    usgs: { magnitude: number; mag_type: string; place: string; time: number; distance_km: number; url: string }[];
    usgs_error: string | null;
    map_events: { magnitude: number; year: number; lat: number; lon: number; distance_km: number }[];
  };
  sources: {
    zone_map: { url: string; title: string; publisher: string; basis: string; sha256: string; retrieved: string };
    annex_e: { url: string; title: string; publisher: string; pdf_page: number; retrieved: string };
    usgs: string;
    soilgrids: string;
    code: string;
  };
  analysis: SeismicAnalysis | { error: string };
}

export async function fetchSeismicAnalysis(opts: {
  soil: SoilType | 'auto'; frame: 'OMRF' | 'SMRF'; importance: number; infill: boolean;
}): Promise<SeismicReport> {
  const params = new URLSearchParams({
    soil: opts.soil, frame: opts.frame, importance: String(opts.importance), infill: String(opts.infill),
  });
  return request<SeismicReport>(`/api/analysis/seismic?${params}`);
}

/** Advisory 0-1 score from the trained structural-risk model (null when there's nothing to score or no model). */
export async function fetchStructuralRisk(): Promise<{ risk: number | null; model_loaded: boolean; district_id: string }> {
  return request('/api/analysis/structural-risk');
}

/** IS 1893 base shear of the building as a fraction of its weight, and the code checks it fails. */
export async function fetchSeismicDemand(): Promise<{ demand: number | null; zone: string | null; warnings: { rule: string; detail: string }[] }> {
  return request('/api/analysis/seismic-demand');
}

// ── AI design generation (backend/services/design_generator.py) ──────────────

export interface DesignBrief {
  rooms?: { type: string; count: number; area_sqft?: number | null }[];
  floors?: number | null;
  budget_inr?: number | null;
  floor_area_sqft?: number | null;
  plot_area_sqft?: number | null;
  shape?: string | null;
  parking_cars?: number;
  garden?: boolean;
  garden_area_sqft?: number | null;
}

export interface DesignEvaluation {
  valid: boolean;
  issues: string[];
  cost: number;
  boq_total: number;
  budget: number;
  remaining: number;
  boq_approximate: boolean;
  boq_notes: string[];
  floors: number;
  rooms: number;
  unplaced: string[];
  floor_use: { floor: number; shape: string; area_sqft: number; rooms_sqft: number; rooms: number }[];
  seismic_demand: number | null;
  code_warnings: { rule: string; detail: string }[];
  suggestions: string[];
}

export interface CandidateMeta {
  shape: string;
  floors: number;
  size_scale: number;
  cost: number;
  code_warnings: number;
}

export interface GenerateResult {
  feasible: boolean;
  parser: 'gemini' | 'rules';
  notes: string[];
  brief: DesignBrief;
  from_setup: string[];
  assumptions: string[];
  warnings: string[];
  missing: string[];
  reasons: string[];
  searched: number;
  chosen?: CandidateMeta;
  alternatives: CandidateMeta[];
  evaluation?: DesignEvaluation;
  why?: string[];
}

export interface DraftInfo {
  exists: boolean;
  state?: BuildingState;
  evaluation?: DesignEvaluation;
  current?: { cost: number; floors: number; rooms: number };
}

export async function generateDesign(prompt: string, overrides?: DesignBrief): Promise<GenerateResult> {
  return request<GenerateResult>('/api/design/generate', {
    method: 'POST', body: JSON.stringify({ prompt, overrides: overrides ?? null }),
  });
}

export async function getDraft(): Promise<DraftInfo> {
  return request<DraftInfo>('/api/design/draft');
}

/** Make the generated design the user's building (the backend re-checks it first). */
export async function applyDraft(): Promise<BuildingState> {
  return request<BuildingState>('/api/design/draft/apply', { method: 'POST' }, 'main');
}

export async function discardDraft(): Promise<DraftInfo> {
  return request<DraftInfo>('/api/design/draft', { method: 'DELETE' }, 'main');
}

// ── Lifecycle & maintenance (backend/services/lifecycle.py) ──────────────────

export interface LifecycleOptions {
  horizon_years: number;
  discount_pct: number;
  structure: 'rcc_framed' | 'load_bearing';
  wall_material: 'burnt_clay_brick' | 'fly_ash_brick' | 'concrete_block' | 'aac_block';
  exterior_wall_in: number | null;
  plaster_mm: number;
  roof_insulation: boolean;
  exterior_finish: 'exterior_emulsion' | 'exterior_cement_paint';
  glass_u: number | null;
  glass_shgc: number | null;
  occupants: number | null;
  town: 'over_100k' | '20k_100k' | null;
  roof_type: 'concrete' | 'tiled' | 'gi_sheet' | 'asbestos';
}

export interface PricedTask {
  task: string; every_years: number; source: string; quantity: number; unit: string; rate: number;
  rate_ref: string; cost_per_event: number; events: number; due_years: number[]; total: number;
  present_value: number; per_year: number;
}

export interface LifecycleSummary {
  initial_cost: number;
  maintenance_priced: number;
  maintenance_priced_pv: number;
  yardstick_total: number;
  retv: number | null;
  u_wall: number;
  u_roof: number;
  harvest_litres: number | null;
  horizon_years: number;
}

export interface LifecycleReport {
  error?: string;
  site: { label: string; lat: number; lon: number; zone: string | null; climate_zone: string | null };
  options: LifecycleOptions;
  initial_cost: number;
  quantities: Record<string, number>;
  maintenance: {
    priced: PricedTask[];
    unpriced: { task: string; every_years: number; source: string; why: string; due_years?: number[] }[];
    replacements: { component: string; life_years: number; source: string; replacements_in_horizon: number; due_years: number[] }[];
    priced_total: number;
    priced_present_value: number;
    yardstick: { annual_repair: number; special_repair: number; electrical: number; total: number; basis: string; source: string };
    inspections: { text: string; source: string }[];
    coastal: boolean;
  };
  envelope: {
    u_wall: number; wall_layers: { layer: string; R: number }[];
    u_roof: number; u_roof_max: number; roof_ok: boolean; roof_layers: { layer: string; R: number }[];
    glass: { u: number; shgc: number; source: string };
    facades: { side: string; faces: string; bearing_deg: number; wall_m2: number; window_m2: number; omega: number }[];
    climate_zone: string | null; wwr: number | null;
    retv: number | null; retv_max?: number; retv_ok?: boolean; retv_note?: string; retv_source?: string;
    coefficients?: { a: number; b: number; c: number };
    window_to_floor_pct: number | null; wfr_min_pct: number | null; wfr_note: string; energy_note: string;
    sources: Record<string, string>; assumptions: string[];
  };
  water: {
    missing: string[];
    harvest: { annual_litres: number; rain_mm: number; roof_m2: number; runoff_coefficient: number; source: string; rain_source: string } | null;
    per_capita: Record<string, { lphd: [number, number]; source: string }>;
    flushing_lphd: { value: number; source: string };
    demand_litres_per_day?: [number, number];
    flushing_litres_per_year?: number;
    harvest_share_of_flushing_pct?: number;
  };
  adaptability: { topic: string; detail: string }[];
  building_life: { years: number; structure: string; source: string; note: string; warning?: string };
  missing: string[];
  summary: LifecycleSummary;
}

export interface LifecycleAlternative { label: string; design: Workspace; options: LifecycleOptions }

export async function fetchLifecycle(options: LifecycleOptions, workspace: Workspace): Promise<LifecycleReport> {
  return request<LifecycleReport>('/api/lifecycle', { method: 'POST', body: JSON.stringify(options) }, workspace);
}

export async function compareLifecycle(alternatives: LifecycleAlternative[]): Promise<{
  alternatives: (LifecycleAlternative & { summary: LifecycleSummary | null; error: string | null; missing: string[] })[];
}> {
  return request('/api/lifecycle/compare', { method: 'POST', body: JSON.stringify({ alternatives }) }, 'main');
}

export async function fetchLifecycleSources(): Promise<{
  generated: string; note: string; sources: Record<string, { title: string; publisher: string; url: string; sha256: string; retrieved: string }>;
}> {
  return request('/api/lifecycle/sources', undefined, 'main');
}

/** Look up a place without moving the building. */
export async function geocode(query: string): Promise<{ lat: number; lng: number; address: string; district_id: string }> {
  return request(`/api/location/geocode?q=${encodeURIComponent(query)}`);
}
