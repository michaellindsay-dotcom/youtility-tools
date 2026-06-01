// Persistent cache of homes pulled from ATTOM, keyed by a ~0.4 mi geo-tile and
// stored in localStorage. Lets the map re-show homes instantly (and avoid
// re-billing ATTOM) when the rep walks/pans back over ground already loaded.
export interface CachedHome { address: string; lat: number; lng: number; }

const KEY = "yk_home_cache_v1";
const TILE = 0.006; // ~0.4 mi per tile
const TTL = 14 * 86400000; // 14 days
const MAX_TILES = 80; // cap localStorage footprint

interface Entry { homes: CachedHome[]; at: number; }
type Cache = Record<string, Entry>;

function load(): Cache {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") as Cache; } catch { return {}; }
}
function save(c: Cache) {
  try {
    // Prune oldest tiles if we're over the cap.
    const keys = Object.keys(c);
    if (keys.length > MAX_TILES) {
      keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - MAX_TILES).forEach((k) => delete c[k]);
    }
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* quota — ignore */ }
}

const idx = (n: number) => Math.round(n / TILE);
export function tileKey(lat: number, lng: number): string { return `${idx(lat)}_${idx(lng)}`; }

// Homes previously pulled for the tile containing (lat,lng), or null on miss.
export function getTile(lat: number, lng: number): CachedHome[] | null {
  const e = load()[tileKey(lat, lng)];
  return e && Date.now() - e.at < TTL ? e.homes : null;
}

export function putTile(lat: number, lng: number, homes: CachedHome[]): void {
  const c = load();
  c[tileKey(lat, lng)] = { homes, at: Date.now() };
  save(c);
}

// All cached homes in the tile around (lat,lng) plus its 8 neighbours — used to
// instantly repaint the map on load before any network call.
export function nearbyCachedHomes(lat: number, lng: number): CachedHome[] {
  const c = load();
  const la = idx(lat), ln = idx(lng);
  const out: CachedHome[] = [];
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++) {
      const e = c[`${la + i}_${ln + j}`];
      if (e && Date.now() - e.at < TTL) out.push(...e.homes);
    }
  return out;
}
