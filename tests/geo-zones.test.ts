import { describe, expect, it } from "vitest";
import type { TargetCity } from "@/lib/cv/types";
import {
  cleanLocation,
  haversineKm,
  linkedinDistanceMiles,
  searchArea,
  zoneVerdict,
} from "@/lib/geo/zones";
import { scoreOffreLocal } from "@/lib/scoring/local";
import { profile } from "./fixtures";

/**
 * Recherche par ville et rayon : zones, verdict d'une offre, nettoyage des
 * libellés de lieu et effet sur le score. Fonctions pures, aucun appel réseau.
 */

const LYON: TargetCity = { name: "Lyon", region: "Auvergne-Rhône-Alpes", country: "France", country_code: "FR", lat: 45.74906, lon: 4.84789, radius_km: 30 };
const VILLEURBANNE = { lat: 45.7787, lon: 4.85972 }; // ~3 km
const VIENNE = { lat: 45.5255, lon: 4.8743 }; // ~25 km
const BOURGOIN = { lat: 45.586, lon: 5.274 }; // ~38 km
const PARIS = { lat: 48.8566, lon: 2.3522 }; // ~390 km
const GENEVE = { lat: 46.2044, lon: 6.1432 };

describe("haversineKm", () => {
  it("Lyon–Paris ≈ 392 km", () => {
    expect(haversineKm(LYON, PARIS)).toBeGreaterThan(385);
    expect(haversineKm(LYON, PARIS)).toBeLessThan(400);
  });
});

describe("searchArea", () => {
  it("une ville restreint son pays ; les autres pays restent entiers", () => {
    const area = searchArea({ target_countries: ["France", "Suisse"], target_cities: [LYON] });
    expect(area.wholeCountries).toEqual(["Suisse"]);
    expect(area.countries).toEqual(["Suisse", "France"]);
  });

  it("ville sans pays coché : son pays est ajouté aux pays concernés", () => {
    expect(searchArea({ target_countries: [], target_cities: [LYON] }).countries).toEqual(["France"]);
  });

  it("profil sans ville (ancien profil) : comportement par pays inchangé", () => {
    const area = searchArea({ target_countries: ["France"] });
    expect(area).toEqual({ wholeCountries: ["France"], cities: [], countries: ["France"] });
  });
});

describe("zoneVerdict", () => {
  const area = searchArea({ target_countries: ["France", "Suisse"], target_cities: [LYON] });

  it("dans le rayon", () => {
    expect(zoneVerdict(area, { country: "France", ...VILLEURBANNE }).verdict).toBe("inside");
    expect(zoneVerdict(area, { country: "France", ...VIENNE }).verdict).toBe("inside");
  });

  it("juste au-delà du rayon : toléré", () => {
    expect(zoneVerdict(area, { country: "France", ...BOURGOIN }).verdict).toBe("near");
  });

  it("nettement hors zone dans un pays restreint", () => {
    const v = zoneVerdict(area, { country: "France", ...PARIS });
    expect(v.verdict).toBe("outside");
    expect(v.nearest?.city.name).toBe("Lyon");
  });

  it("pays couvert entièrement : la zone ne s'applique pas", () => {
    expect(zoneVerdict(area, { country: "Suisse", ...GENEVE }).verdict).toBe("no-zone");
  });

  it("lieu inconnu dans un pays restreint", () => {
    expect(zoneVerdict(area, { country: "France" }).verdict).toBe("unknown");
  });

  it("sans ville cible : no-zone", () => {
    expect(zoneVerdict(searchArea({ target_countries: ["France"] }), { country: "France", ...PARIS }).verdict).toBe("no-zone");
  });
});

describe("cleanLocation", () => {
  it.each([
    ["Lyon 3e Arrondissement", { name: "Lyon", dept: null }],
    ["Paris 15e", { name: "Paris", dept: null }],
    ["69 - DARDILLY", { name: "Dardilly", dept: "69" }],
    ["Lyon - 69", { name: "Lyon", dept: "69" }],
    ["69003 Lyon", { name: "Lyon", dept: "69" }],
    ["Saint-Priest (69)", { name: "Saint-Priest", dept: "69" }],
    ["Paris, Île-de-France, France", { name: "Paris", dept: null }],
    ["Genève", { name: "Genève", dept: null }],
    ["ST FONS", { name: "Saint Fons", dept: null }],
    ["STE FOY LES LYON", { name: "Sainte Foy Les Lyon", dept: null }],
    ["CHAZAY D AZERGUES", { name: "Chazay D'Azergues", dept: null }],
    ["Saint-Étienne", { name: "Saint-Étienne", dept: null }],
  ])("%s", (raw, expected) => {
    expect(cleanLocation(raw)).toEqual(expected);
  });

  it.each(["Télétravail", "France", "", "75"])("pas une ville : %s", (raw) => {
    expect(cleanLocation(raw)).toBeNull();
  });
});

describe("linkedinDistanceMiles", () => {
  it("plus petite distance LinkedIn qui couvre le rayon", () => {
    expect(linkedinDistanceMiles(5)).toBe(5);
    expect(linkedinDistanceMiles(30)).toBe(25);
    expect(linkedinDistanceMiles(50)).toBe(50);
    expect(linkedinDistanceMiles(100)).toBe(100);
  });
});

describe("score : critère lieu", () => {
  const withLyon = { ...profile, target_countries: ["France"], target_cities: [LYON] };
  const offre = (point: { lat?: number; lon?: number }, country = "France") => ({
    title: "Cheffe de projet digital",
    company: "Exemple",
    country,
    description_text: "Pilotage de projets digital, gestion de projet, SQL.",
    contract_type: "CDI",
    ...point,
  });

  it("dans le rayon : 100, distance dans la raison", () => {
    const r = scoreOffreLocal(withLyon, offre(VILLEURBANNE));
    expect(r.breakdown.country).toBe(100);
    expect(r.reason).toMatch(/à 3 km de Lyon/);
  });

  it("hors zone : 0 et score plus bas que la même offre dans le rayon", () => {
    const inside = scoreOffreLocal(withLyon, offre(VILLEURBANNE));
    const outside = scoreOffreLocal(withLyon, offre(PARIS));
    expect(outside.breakdown.country).toBe(0);
    expect(outside.reason).toMatch(/hors zone \(39\d km de Lyon\)/);
    expect(outside.score).toBeLessThan(inside.score);
  });

  it("lieu inconnu : neutre", () => {
    expect(scoreOffreLocal(withLyon, offre({})).breakdown.country).toBe(50);
  });

  it("sans ville : règle des pays d'avant", () => {
    const byCountry = { ...profile, target_countries: ["France"], target_cities: [] };
    expect(scoreOffreLocal(byCountry, offre(PARIS)).breakdown.country).toBe(100);
    expect(scoreOffreLocal(byCountry, offre(GENEVE, "Suisse")).breakdown.country).toBe(0);
  });
});
