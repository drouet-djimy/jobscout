import "server-only";
import { getDb } from "@/lib/db";
import { COUNTRY_CODE_TO_NAME, nameToCode } from "@/lib/countries";
import type { TargetCity } from "@/lib/cv/types";
import { cleanLocation } from "./zones";

/**
 * Géocodage des villes, sans clé ni compte :
 * - Open-Meteo (données GeoNames, monde entier, noms en français) pour la
 *   recherche de villes cibles et les lieux d'offres hors de France ;
 * - geo.api.gouv.fr (référentiel officiel des communes) pour la France : plus
 *   complet (communes nouvelles) et seul à donner le code commune INSEE que
 *   France Travail exige pour une recherche par rayon.
 * Appelé seulement quand le profil cible des villes. Résultats mis en cache
 * dans la table geocache : un même lieu n'est demandé qu'une fois.
 */

const OPEN_METEO = "https://geocoding-api.open-meteo.com/v1/search";
const GEO_GOUV = "https://geo.api.gouv.fr/communes";
const TIMEOUT_MS = 8000;

export type PlaceSuggestion = Omit<TargetCity, "radius_km"> & { population: number | null };

type OpenMeteoResult = {
  name: string;
  latitude: number;
  longitude: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  population?: number;
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Géocodage HTTP ${res.status}`);
  return (await res.json()) as T;
}

function countryName(code: string, fallback?: string): string {
  return COUNTRY_CODE_TO_NAME[code] ?? fallback ?? code;
}

async function openMeteo(name: string, opts: { count: number; countryCode?: string | null }): Promise<OpenMeteoResult[]> {
  const params = new URLSearchParams({ name, count: String(opts.count), language: "fr", format: "json" });
  if (opts.countryCode) params.set("countryCode", opts.countryCode);
  const data = await getJson<{ results?: OpenMeteoResult[] }>(`${OPEN_METEO}?${params}`);
  // Lieux habités uniquement (pas de rivières, montagnes, aéroports…).
  return (data.results ?? []).filter((r) => !r.feature_code || r.feature_code.startsWith("PPL"));
}

/** Suggestions pour le champ « Ajouter une ville » (au moins 2 caractères). */
export async function searchPlaces(query: string, limit = 8): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const results = await openMeteo(q, { count: Math.min(20, limit * 2) });
  const out: PlaceSuggestion[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const cc = (r.country_code ?? "").toUpperCase();
    if (cc.length !== 2) continue;
    const region = r.admin1 ?? r.admin2 ?? null;
    const key = `${r.name}|${region}|${cc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: r.name,
      region,
      country: countryName(cc, r.country),
      country_code: cc,
      lat: Math.round(r.latitude * 1e5) / 1e5,
      lon: Math.round(r.longitude * 1e5) / 1e5,
      population: r.population ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Cache
// ----------------------------------------------------------------------------

type CacheRow = { lat: number | null; lon: number | null; extra: string | null };

function cacheGet(key: string): CacheRow | undefined {
  return getDb().prepare("SELECT lat, lon, extra FROM geocache WHERE key = ?").get(key) as CacheRow | undefined;
}

function cacheSet(key: string, lat: number | null, lon: number | null, extra: string | null = null): void {
  getDb()
    .prepare(
      "INSERT INTO geocache (key, lat, lon, extra) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, extra = excluded.extra, created_at = datetime('now')"
    )
    .run(key, lat, lon, extra);
}

const keyPart = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

// ----------------------------------------------------------------------------
// Lieux des offres
// ----------------------------------------------------------------------------

type GouvCommune = { nom: string; code: string; centre?: { coordinates?: [number, number] } };

/**
 * Coordonnées du lieu d'une offre (« Lyon 3e Arrondissement », « 69 - DARDILLY »,
 * « Genève »…) dans le pays indiqué. null si introuvable ou service injoignable :
 * l'offre est alors gardée et notée « lieu inconnu », jamais écartée.
 */
export async function geocodeLocation(
  location: string | null | undefined,
  country: string | null | undefined
): Promise<{ lat: number; lon: number } | null> {
  const place = cleanLocation(location);
  if (!place) return null;
  const cc = (country && (nameToCode(country) ?? (country.length === 2 ? country.toUpperCase() : null))) || null;
  const key = `loc|${cc ?? "*"}|${keyPart(place.name)}|${place.dept ?? ""}`;
  const cached = cacheGet(key);
  if (cached) return cached.lat != null && cached.lon != null ? { lat: cached.lat, lon: cached.lon } : null;

  try {
    let point: { lat: number; lon: number } | null = null;
    if (cc === "FR") {
      const params = new URLSearchParams({ nom: place.name, fields: "nom,code,centre", boost: "population", limit: "1" });
      if (place.dept) params.set("codeDepartement", place.dept);
      const [commune] = await getJson<GouvCommune[]>(`${GEO_GOUV}?${params}`);
      const c = commune?.centre?.coordinates;
      if (c) point = { lat: c[1], lon: c[0] };
    }
    if (!point) {
      const [r] = await openMeteo(place.name, { count: 1, countryCode: cc });
      if (r) point = { lat: r.latitude, lon: r.longitude };
    }
    cacheSet(key, point?.lat ?? null, point?.lon ?? null);
    return point;
  } catch {
    // Réseau ou service indisponible : pas de mise en cache, on réessaiera au prochain scan.
    return null;
  }
}

/**
 * Code commune INSEE d'une ville française, pour la recherche par rayon de
 * France Travail (paramètre `lieux` / `commune`). null hors de France ou si
 * le service ne répond pas.
 */
export async function communeCode(city: Pick<TargetCity, "lat" | "lon" | "country_code">): Promise<string | null> {
  if (city.country_code !== "FR") return null;
  const key = `insee|${city.lat.toFixed(4)},${city.lon.toFixed(4)}`;
  const cached = cacheGet(key);
  if (cached) return cached.extra;
  try {
    const params = new URLSearchParams({ lat: String(city.lat), lon: String(city.lon), fields: "nom,code" });
    const [commune] = await getJson<GouvCommune[]>(`${GEO_GOUV}?${params}`);
    const code = commune?.code ?? null;
    cacheSet(key, city.lat, city.lon, code);
    return code;
  } catch {
    return null;
  }
}
