import { NextRequest, NextResponse } from "next/server";
import { searchPlaces } from "@/lib/geo/geocode";

export const runtime = "nodejs";

// Suggestions de villes pour Profil › Recherche › Villes (et l'onboarding).
// Seul le texte tapé part vers le service de géocodage (voir lib/geo/geocode.ts).
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (q.length < 2) return NextResponse.json({ places: [] });
  try {
    const places = await searchPlaces(q);
    return NextResponse.json({ places }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Recherche de villes indisponible. Vérifiez votre connexion à Internet, puis réessayez." },
      { status: 502 }
    );
  }
}
