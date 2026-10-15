"use client";
import { useEffect, useId, useRef, useState } from "react";
import { MapPin, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { TargetCity } from "@/lib/cv/types";
import { DEFAULT_RADIUS_KM, RADIUS_OPTIONS } from "@/lib/geo/zones";

type Suggestion = Omit<TargetCity, "radius_km"> & { population: number | null };

const MAX_CITIES = 20;

function sameCity(a: Pick<TargetCity, "name" | "country_code" | "lat" | "lon">, b: typeof a): boolean {
  return a.country_code === b.country_code && a.name === b.name && Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
}

/**
 * Villes cibles avec un rayon. Une ville restreint son pays à la zone choisie ;
 * les pays cochés sans ville restent couverts entièrement.
 */
export function CityPicker({
  cities,
  onChange,
}: {
  cities: TargetCity[];
  onChange: (cities: TargetCity[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setLoading(false);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geo/cities?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Recherche de villes indisponible.");
        setSuggestions(data.places ?? []);
        setActive(0);
        setOpen(true);
        setError(null);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setSuggestions([]);
        setError(e instanceof Error ? e.message : "Recherche de villes indisponible.");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [query]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function add(s: Suggestion) {
    setQuery("");
    setSuggestions([]);
    setOpen(false);
    if (cities.some((c) => sameCity(c, s)) || cities.length >= MAX_CITIES) return;
    const { population: _population, ...city } = s;
    onChange([...cities, { ...city, radius_km: DEFAULT_RADIUS_KM }]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && suggestions[active]) add(suggestions[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const showList = open && query.trim().length >= 2 && !loading;

  return (
    <div>
      {cities.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {cities.map((c, i) => (
            <li key={`${c.name}-${c.lat}-${c.lon}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
              <MapPin aria-hidden="true" className="h-4 w-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="text-small font-medium text-text">{c.name}</span>
                <span className="text-caption text-textSecondary"> · {[c.region, c.country].filter(Boolean).join(", ")}</span>
              </span>
              <label className="sr-only" htmlFor={`${listId}-r${i}`}>Rayon autour de {c.name}</label>
              <select
                id={`${listId}-r${i}`}
                value={c.radius_km}
                onChange={(e) => onChange(cities.map((x, j) => (j === i ? { ...x, radius_km: Number(e.target.value) } : x)))}
                className="h-9 rounded-md border border-border bg-bg px-2 text-small text-text focus:border-accent focus:outline-none"
              >
                {(RADIUS_OPTIONS as readonly number[]).includes(c.radius_km) ? null : <option value={c.radius_km}>{c.radius_km} km</option>}
                {RADIUS_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r} km</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => onChange(cities.filter((_, j) => j !== i))}
                aria-label={`Retirer ${c.name}`}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-textSecondary hover:bg-surfaceHover hover:text-text"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div ref={boxRef} className="relative">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => suggestions.length && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={cities.length >= MAX_CITIES ? `${MAX_CITIES} villes maximum` : "Ajouter une ville (ex. Lyon, Genève, Montréal)"}
          disabled={cities.length >= MAX_CITIES}
          role="combobox"
          aria-label="Ajouter une ville"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && suggestions[active] ? `${listId}-${active}` : undefined}
        />
        {loading && <Spinner size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-textSecondary" />}
        {showList && (
          <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-bg py-1 shadow-lg">
            {suggestions.length === 0 ? (
              <li className="px-3 py-2 text-small text-textSecondary">Aucune ville trouvée.</li>
            ) : (
              suggestions.map((s, i) => (
                <li
                  key={`${s.name}-${s.lat}-${s.lon}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn("cursor-pointer px-3 py-2 text-small", i === active ? "bg-surfaceHover text-text" : "text-text")}
                >
                  <span className="font-medium">{s.name}</span>
                  <span className="text-textSecondary"> · {[s.region, s.country].filter(Boolean).join(", ")}</span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {error && <p role="alert" className="mt-1.5 text-small text-danger">{error}</p>}
    </div>
  );
}
