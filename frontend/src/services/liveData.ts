/**
 * Live site conditions from free, key-less public APIs, called straight from
 * the browser (all CORS-enabled):
 *   - Open-Meteo Forecast   — current temperature, humidity, wind, solar radiation
 *   - Open-Meteo Historical — the site's own climate over the last 3 years, the
 *                             baseline the live readings are compared against
 *   - Open-Meteo Geocoding  — district coordinates when no site has been set
 *   - USGS FDSN             — recent earthquakes near the site
 * The code design values in karnataka_db.ts (IS 875 wind speed etc.) remain
 * the basis for the engineering calculations elsewhere.
 */

/** District HQ coordinates (lat, lon) — offline fallback when geocoding is unreachable. */
export const DISTRICT_COORDS: Record<string, [number, number]> = {
  'bengaluru-urban': [12.9716, 77.5946],
  'mysuru':          [12.2958, 76.6394],
  'mangaluru':       [12.9141, 74.8560],
  'belagavi':        [15.8497, 74.4977],
  'dharwad':         [15.4589, 75.0078],
  'ballari':         [15.1394, 76.9214],
  'shivamogga':      [13.9299, 75.5681],
  'hassan':          [13.0072, 76.0962],
  'tumakuru':        [13.3379, 77.1173],
  'kalaburagi':      [17.3297, 76.8343],
  'raichur':         [16.2076, 77.3463],
  'bidar':           [17.9104, 77.5199],
  'uttara-kannada':  [14.8136, 74.1295],
  'udupi':           [13.3409, 74.7421],
  'gadag':           [15.4316, 75.6355],
};

export interface LiveWeather {
  time: string;
  temperatureC: number;
  humidityPct: number;
  windKmh: number;
  gustKmh: number;
  windDirDeg: number;
  solarWm2: number;
}

export interface Quake {
  id: string;
  magnitude: number;
  place: string;
  time: number;
  distanceKm: number;
  url: string;
}

/** The site's recent climate, from Open-Meteo's historical archive. */
export interface ClimateBaseline {
  /** 95th percentile of daily maximum temperature over CLIMATE_YEARS — a typical hot day */
  hotDayC: number;
  /** Strongest daily gust recorded over CLIMATE_YEARS */
  recordGustKmh: number;
  /** Average of each day's peak solar radiation over the last year */
  avgPeakSolarWm2: number;
  years: number;
  from: string;
  to: string;
}

export interface LiveConditions {
  weather: LiveWeather | null;
  quakes: Quake[] | null;
  /** Coordinates actually queried, and where they came from */
  coords: [number, number];
  coordsSource: 'site' | 'geocoded' | 'fallback';
  fetchedAt: number;
}

const QUAKE_RADIUS_KM = 500;
const QUAKE_LOOKBACK_DAYS = 365;
const CLIMATE_YEARS = 3;
// The archive lags real time by a few days
const ARCHIVE_LAG_DAYS = 6;
const CLIMATE_TTL_MS = 7 * 86_400_000;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

async function fetchWeather(lat: number, lon: number, signal?: AbortSignal): Promise<LiveWeather> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,shortwave_radiation',
    wind_speed_unit: 'kmh',
    timezone: 'auto',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const c = (await res.json()).current;
  return {
    time: c.time,
    temperatureC: c.temperature_2m,
    humidityPct: c.relative_humidity_2m,
    windKmh: c.wind_speed_10m,
    gustKmh: c.wind_gusts_10m,
    windDirDeg: c.wind_direction_10m,
    solarWm2: c.shortwave_radiation,
  };
}

async function fetchQuakes(lat: number, lon: number, signal?: AbortSignal): Promise<Quake[]> {
  const start = new Date(Date.now() - QUAKE_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    format: 'geojson',
    latitude: String(lat),
    longitude: String(lon),
    maxradiuskm: String(QUAKE_RADIUS_KM),
    starttime: start,
    minmagnitude: '2',
    orderby: 'time',
    limit: '20',
  });
  const res = await fetch(`https://earthquake.usgs.gov/fdsnws/event/1/query?${params}`, { signal });
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
  const data = await res.json();
  return (data.features ?? []).map((f: { id: string; properties: { mag: number; place: string; time: number; url: string }; geometry: { coordinates: number[] } }) => ({
    id: f.id,
    magnitude: f.properties.mag,
    place: f.properties.place,
    time: f.properties.time,
    url: f.properties.url,
    distanceKm: Math.round(haversineKm(lat, lon, f.geometry.coordinates[1], f.geometry.coordinates[0])),
  }));
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Climate changes slowly — cache per location (in memory, and in localStorage when allowed)
const climateCache = new Map<string, { at: number; value: ClimateBaseline }>();

function readCachedClimate(key: string): ClimateBaseline | null {
  const hit = climateCache.get(key);
  if (hit && Date.now() - hit.at < CLIMATE_TTL_MS) return hit.value;
  try {
    const stored = JSON.parse(localStorage.getItem(`climate:${key}`) ?? 'null');
    if (stored && Date.now() - stored.at < CLIMATE_TTL_MS) {
      climateCache.set(key, stored);
      return stored.value;
    }
  } catch { /* storage unavailable */ }
  return null;
}

/**
 * The site's recent climate from Open-Meteo's historical archive. Two requests in
 * parallel: 3 years of daily temperature/gust (small, ~1 s) and 1 year of hourly
 * solar for the daily peaks (3 years hourly is ~4× slower for little gain).
 */
export async function fetchClimate(lat: number, lon: number, signal?: AbortSignal): Promise<ClimateBaseline> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const cached = readCachedClimate(key);
  if (cached) return cached;

  const end = new Date(Date.now() - ARCHIVE_LAG_DAYS * 86_400_000);
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - CLIMATE_YEARS);
  const solarStart = new Date(end);
  solarStart.setFullYear(end.getFullYear() - 1);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const archive = async (from: Date, vars: Record<string, string>) => {
    const params = new URLSearchParams({
      latitude: String(lat), longitude: String(lon),
      start_date: iso(from), end_date: iso(end),
      wind_speed_unit: 'kmh', timezone: 'auto', ...vars,
    });
    const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${params}`, { signal });
    if (!res.ok) throw new Error(`Open-Meteo archive HTTP ${res.status}`);
    return res.json();
  };
  const [dailyData, hourlyData] = await Promise.all([
    archive(start, { daily: 'temperature_2m_max,wind_gusts_10m_max' }),
    archive(solarStart, { hourly: 'shortwave_radiation' }),
  ]);
  const temps: number[] = dailyData.daily.temperature_2m_max.filter((v: number | null) => v !== null);
  const gusts: number[] = dailyData.daily.wind_gusts_10m_max.filter((v: number | null) => v !== null);
  // Peak hour of each day (24 hourly values per day)
  const solar: (number | null)[] = hourlyData.hourly.shortwave_radiation;
  const dailyPeaks: number[] = [];
  for (let i = 0; i + 24 <= solar.length; i += 24) {
    const day = solar.slice(i, i + 24).filter((v): v is number => v !== null);
    if (day.length) dailyPeaks.push(Math.max(...day));
  }
  if (!temps.length || !gusts.length || !dailyPeaks.length) throw new Error('Open-Meteo archive returned no data');

  const value: ClimateBaseline = {
    hotDayC: Math.round(percentile(temps, 95) * 10) / 10,
    recordGustKmh: Math.round(Math.max(...gusts)),
    avgPeakSolarWm2: Math.round(dailyPeaks.reduce((s, v) => s + v, 0) / dailyPeaks.length),
    years: CLIMATE_YEARS,
    from: iso(start),
    to: iso(end),
  };
  const entry = { at: Date.now(), value };
  climateCache.set(key, entry);
  try { localStorage.setItem(`climate:${key}`, JSON.stringify(entry)); } catch { /* storage unavailable */ }
  return value;
}

const geocodeCache = new Map<string, [number, number]>();

/** District coordinates from Open-Meteo Geocoding (restricted to Karnataka), e.g. "Mangaluru (Dakshina Kannada)" → Mangaluru. */
async function geocodeDistrict(name: string, signal?: AbortSignal): Promise<[number, number]> {
  const cached = geocodeCache.get(name);
  if (cached) return cached;
  const query = name.replace(/\(.*?\)/g, '').replace(/\burban\b|\brural\b/gi, '').trim();
  const params = new URLSearchParams({ name: query, count: '5', countryCode: 'IN', language: 'en', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Open-Meteo geocoding HTTP ${res.status}`);
  const hit = ((await res.json()).results ?? []).find((r: { admin1?: string }) => r.admin1 === 'Karnataka');
  if (!hit) throw new Error(`No Karnataka match for "${query}"`);
  const coords: [number, number] = [hit.latitude, hit.longitude];
  geocodeCache.set(name, coords);
  return coords;
}

/** The exact site when the user has set one, otherwise the district HQ (synchronous, for display). */
export function siteCoords(districtId: string, location?: { lat: number; lng: number } | null): [number, number] {
  if (location) return [location.lat, location.lng];
  return DISTRICT_COORDS[districtId] ?? DISTRICT_COORDS['bengaluru-urban'];
}

/** Fetch all feeds; a failure in one doesn't hide the others. */
export async function fetchLiveConditions(
  district: { id: string; name: string },
  signal?: AbortSignal,
  location?: { lat: number; lng: number } | null,
): Promise<LiveConditions> {
  let coords: [number, number];
  let coordsSource: LiveConditions['coordsSource'];
  if (location) {
    coords = [location.lat, location.lng];
    coordsSource = 'site';
  } else {
    try {
      coords = await geocodeDistrict(district.name, signal);
      coordsSource = 'geocoded';
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      coords = siteCoords(district.id);
      coordsSource = 'fallback';
    }
  }
  // The climate baseline is slower — the card fetches it separately with fetchClimate
  const [weather, quakes] = await Promise.allSettled([
    fetchWeather(coords[0], coords[1], signal),
    fetchQuakes(coords[0], coords[1], signal),
  ]);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return {
    weather: weather.status === 'fulfilled' ? weather.value : null,
    quakes: quakes.status === 'fulfilled' ? quakes.value : null,
    coords,
    coordsSource,
    fetchedAt: Date.now(),
  };
}

export const QUAKE_SEARCH = { radiusKm: QUAKE_RADIUS_KM, days: QUAKE_LOOKBACK_DAYS };
