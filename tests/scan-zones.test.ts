import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrapeCriteria, ScrapedOffre, Scraper } from "@/lib/scrapers/base";
import type { TargetCity } from "@/lib/cv/types";
import { getDb } from "@/lib/db";
import { profile } from "./fixtures";

/**
 * runScan avec des villes cibles : les scrapers reçoivent les zones, et les
 * offres nettement hors zone ne sont pas enregistrées. Faux scraper qui donne
 * ses coordonnées (aucun géocodage, donc aucun appel réseau).
 */

const LYON: TargetCity = { name: "Lyon", region: null, country: "France", country_code: "FR", lat: 45.74906, lon: 4.84789, radius_km: 30 };

const state = vi.hoisted(() => ({
  criteria: null as ScrapeCriteria | null,
  offres: [] as Partial<ScrapedOffre>[],
}));

vi.mock("@/lib/db/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/queries")>()),
  getProfile: () => ({
    ...profile,
    sources_enabled: ["fake"],
    target_countries: ["France", "Suisse"],
    target_cities: [LYON],
  }),
}));

vi.mock("@/lib/scrapers/registry", () => {
  const fake: Scraper = {
    name: "fake",
    async *scrape(criteria, onEvent) {
      state.criteria = criteria;
      onEvent({ kind: "start", source: "fake" });
      for (const [i, o] of state.offres.entries()) {
        yield {
          source_id: `z-${i}`,
          url: `https://example.org/z/${i}`,
          title: `Poste ${i}`,
          company: "Exemple",
          country: "France",
          location: null,
          contract_type: "CDI",
          salary: null,
          description_html: "<p>Description</p>",
          description_text: "Description du poste, suffisamment longue pour être retenue.",
          description_status: "ok",
          posted_at: null,
          is_vie: false,
          raw_payload: {},
          ...o,
        } as ScrapedOffre;
      }
      onEvent({ kind: "done", source: "fake", seen: state.offres.length, ok: state.offres.length, failed: 0 });
    },
  };
  return { VALID_SOURCES: ["fake"], getEnabledScrapers: () => [fake] };
});

vi.mock("@/lib/sources-meta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sources-meta")>()),
  sourceUnavailable: () => false,
}));

beforeEach(() => {
  getDb().exec("DELETE FROM offres");
});

async function scan(): Promise<string[]> {
  const { runScan } = await import("@/lib/scan/orchestrator");
  const lines: string[] = [];
  for await (const _ of runScan((l) => lines.push(l))) void _;
  return lines;
}

describe("runScan — villes et rayon", () => {
  it("transmet les zones aux scrapers", async () => {
    state.offres = [];
    await scan();
    expect(state.criteria?.cities).toEqual([LYON]);
    expect(state.criteria?.countries).toEqual(["Suisse", "France"]);
  });

  it("écarte les offres nettement hors zone, garde la zone, la Suisse et les lieux inconnus", async () => {
    state.offres = [
      { title: "Villeurbanne", lat: 45.7787, lon: 4.85972 },
      { title: "Paris", lat: 48.8566, lon: 2.3522 },
      { title: "Genève", country: "Suisse", lat: 46.2044, lon: 6.1432 },
      { title: "Lieu inconnu" },
    ];
    const lines = await scan();
    const rows = getDb().prepare("SELECT title, lat FROM offres ORDER BY title").all() as { title: string; lat: number | null }[];
    expect(rows.map((r) => r.title)).toEqual(["Genève", "Lieu inconnu", "Villeurbanne"]);
    expect(rows.find((r) => r.title === "Villeurbanne")?.lat).toBeCloseTo(45.7787);
    expect(lines.some((l) => /1 hors zone/.test(l))).toBe(true);
    expect(lines.some((l) => /Zones : Lyon \(30 km\) · pays entiers : Suisse/.test(l))).toBe(true);
  });
});
