// Zones de recherche : pays entiers + villes avec un rayon.
// Module pur (aucun accès réseau ni base) : partagé par l'interface, les
// scrapers, l'orchestrateur du scan et le scoring local.
//
// Règle : une ville restreint son pays à la zone choisie. Un pays coché sans
// aucune ville reste couvert entièrement. Ex. pays « France, Suisse » + ville
// « Lyon, 30 km » → toute la Suisse, et la France autour de Lyon seulement.

import type { TargetCity } from "@/lib/cv/types";
import { strictCountryName } from "@/lib/countries";

export type { TargetCity };

/** Rayons proposés dans l'interface, en km. */
export const RADIUS_OPTIONS = [5, 10, 20, 30, 50, 100] as const;
export const DEFAULT_RADIUS_KM = 30;

/**
 * Marge au-delà du rayon avant d'écarter une offre au scan : les sites et nos
 * géocodages ne mesurent pas la distance depuis le même point (centre de la
 * commune, adresse de l'agence, code postal…). Au-delà de rayon + marge,
 * l'offre est hors zone.
 */
export function toleranceKm(radiusKm: number): number {
  return Math.max(10, radiusKm * 0.5);
}

type Point = { lat: number; lon: number };

/** Distance à vol d'oiseau, en km (formule de haversine). */
export function haversineKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function countryKey(name: string | null | undefined): string {
  return (strictCountryName(name) ?? name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

export type SearchArea = {
  /** Pays couverts entièrement (cochés, sans aucune ville). */
  wholeCountries: string[];
  /** Villes cibles, avec leur rayon. */
  cities: TargetCity[];
  /** Tous les pays concernés : pays entiers + pays des villes, sans doublon. */
  countries: string[];
};

export function searchArea(p: {
  target_countries?: string[] | null;
  target_cities?: TargetCity[] | null;
}): SearchArea {
  const cities = p.target_cities ?? [];
  const zoneKeys = new Set(cities.map((c) => countryKey(c.country)));
  const wholeCountries = (p.target_countries ?? []).filter((c) => !zoneKeys.has(countryKey(c)));
  const countries: string[] = [];
  const seen = new Set<string>();
  for (const c of [...wholeCountries, ...cities.map((x) => x.country)]) {
    const k = countryKey(c);
    if (seen.has(k)) continue;
    seen.add(k);
    countries.push(c);
  }
  return { wholeCountries, cities, countries };
}

/** Villes cibles d'un pays donné (nom français, alias ou code ISO). */
export function citiesIn(cities: TargetCity[], country: string): TargetCity[] {
  const k = countryKey(country);
  return cities.filter((c) => countryKey(c.country) === k || c.country_code === country.toUpperCase());
}

export function nearestCity(
  cities: TargetCity[],
  point: Point
): { city: TargetCity; km: number } | null {
  let best: { city: TargetCity; km: number } | null = null;
  for (const city of cities) {
    const km = haversineKm(city, point);
    // La « plus proche » au sens du rayon : on retient la ville dont la zone est
    // la moins dépassée (Lyon 30 km à 40 km bat Grenoble 10 km à 35 km).
    if (!best || km - city.radius_km < best.km - best.city.radius_km) best = { city, km };
  }
  return best;
}

export type ZoneVerdict =
  /** Aucune ville cible, ou offre dans un pays couvert entièrement : la règle des pays s'applique. */
  | "no-zone"
  /** Dans le rayon d'une ville cible. */
  | "inside"
  /** Juste au-delà du rayon (marge de tolérance). */
  | "near"
  /** Nettement hors zone, dans un pays restreint à ses villes. */
  | "outside"
  /** Pays restreint à ses villes, mais lieu de l'offre inconnu. */
  | "unknown";

export function zoneVerdict(
  area: SearchArea,
  offre: { country: string | null; lat?: number | null; lon?: number | null }
): { verdict: ZoneVerdict; nearest: { city: TargetCity; km: number } | null } {
  if (!area.cities.length) return { verdict: "no-zone", nearest: null };
  const hasPoint = offre.lat != null && offre.lon != null;
  const nearest = hasPoint ? nearestCity(area.cities, { lat: offre.lat!, lon: offre.lon! }) : null;
  if (nearest && nearest.km <= nearest.city.radius_km) return { verdict: "inside", nearest };

  // Pays de l'offre couvert entièrement : la zone ne le concerne pas.
  if (offre.country) {
    const k = countryKey(offre.country);
    const restricted = area.cities.some((c) => countryKey(c.country) === k);
    if (!restricted) return { verdict: "no-zone", nearest };
  }
  if (!nearest) return { verdict: "unknown", nearest: null };
  return {
    verdict: nearest.km <= nearest.city.radius_km + toleranceKm(nearest.city.radius_km) ? "near" : "outside",
    nearest,
  };
}

/** « Lyon (30 km) » */
export function cityLabel(city: Pick<TargetCity, "name" | "radius_km">): string {
  return `${city.name} (${city.radius_km} km)`;
}

/** LinkedIn n'accepte que quelques distances, en miles : on prend la plus petite qui couvre le rayon. */
export function linkedinDistanceMiles(radiusKm: number): number {
  const miles = radiusKm / 1.609;
  return [5, 10, 25, 50, 100].find((m) => m >= miles) ?? 100;
}

// ----------------------------------------------------------------------------
// Libellés de lieu des offres → nom de commune géocodable
// ----------------------------------------------------------------------------

const NOT_A_PLACE =
  /^(?:t[ée]l[ée]travail|remote|full remote|hybride?|hybrid|[àa] distance|non (?:pr[ée]cis[ée]|communiqu[ée])|plusieurs (?:lieux|villes)|divers|nationale?|international|monde|world ?wide|anywhere)$/i;

/**
 * Nettoie un libellé de lieu d'offre pour le géocoder.
 *  « Lyon 3e Arrondissement » → Lyon ; « 69 - DARDILLY » → Dardilly (69) ;
 *  « Lyon - 69 » → Lyon (69) ; « 69003 Lyon » → Lyon (69) ;
 *  « Paris, Île-de-France, France » → Paris ; « Télétravail » → null.
 * `dept` : département français déduit (2 chiffres, 2A/2B ou 3 pour l'outre-mer).
 */
export function cleanLocation(raw: string | null | undefined): { name: string; dept: string | null } | null {
  if (!raw) return null;
  let s = raw.replace(/\s+/g, " ").trim();
  if (!s) return null;
  let dept: string | null = null;

  // Premier segment d'une liste « ville, région, pays » ou « ville / ville ».
  s = s.split(/[,;/|•]/)[0].trim();

  // « Ville (69) » / « Ville (69003) »
  const paren = s.match(/\((\d{2,3}|2[AB])\d{0,3}\)/i);
  if (paren) dept = paren[1].toUpperCase();
  s = s.replace(/\([^)]*\)/g, " ").trim();

  // « 69 - Dardilly » / « Lyon - 69 »
  let m = s.match(/^(\d{2,3}|2[AB])\s+-\s+(.+)$/i);
  if (m) {
    dept = m[1].toUpperCase();
    s = m[2];
  }
  m = s.match(/^(.+?)\s+-\s+(\d{2,3}|2[AB])$/i);
  if (m) {
    s = m[1];
    dept = m[2].toUpperCase();
  }

  // Codes postaux : « 69003 Lyon », « Lyon 69003 »
  m = s.match(/\b(\d{5})\b/);
  if (m) {
    dept ??= m[1].startsWith("97") ? m[1].slice(0, 3) : m[1].slice(0, 2);
    s = s.replace(/\b\d{5}\b/, " ");
  }
  s = s.replace(/\bcedex\b.*$/i, " ");

  // Arrondissements : « Lyon 3e Arrondissement », « Paris 15e », « Marseille 8ème »
  s = s.replace(/\s+\d{1,2}\s*(?:e|er|ème|eme|è)?\s*(?:arr(?:ondissement|\.)?)?$/i, "");
  s = s.replace(/\s+-\s*$/, "").replace(/\s+/g, " ").trim();

  if (s.length < 2 || /^\d+$/.test(s) || NOT_A_PLACE.test(s)) return null;
  // Un nom de pays seul n'est pas une ville.
  if (strictCountryName(s)) return null;

  // « DARDILLY » → « Dardilly » (les géocodeurs s'en accommodent, mais le cache aussi).
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
  }
  // Abréviations et apostrophes perdues (France Travail) : « ST FONS » → Saint Fons,
  // « CHAZAY D AZERGUES » → Chazay D'Azergues.
  s = s
    .replace(/(^|[\s-])(St|Ste)\.?(?=[\s-])/gi, (_, sep: string, abbr: string) => sep + (abbr.length === 3 ? "Sainte" : "Saint"))
    .replace(/(\s)([DL])\s+(?=[AEIOUYHÀÂÉÈÊÎÔ])/gi, (_, sep: string, art: string) => `${sep}${art}'`);
  return { name: s, dept };
}
