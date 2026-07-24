import type { MediaRef, PosterCandidate, PosterSource } from "./types.ts";
import { tmdbSource } from "./tmdb.ts";
import { fanartSource } from "./fanart.ts";

// Registre des sources. Ajouter une source = l'importer et l'ajouter ici.
const sources: PosterSource[] = [tmdbSource, fanartSource];

export interface RankedCandidate extends PosterCandidate {
  /** Score de tri interne posterarr (préférence langue + popularité). */
  rank: number;
}

/**
 * Interroge toutes les sources qui prennent en charge le média, en parallèle,
 * et renvoie les candidats fusionnés et triés. Une source qui échoue est ignorée.
 */
export async function getCandidates(
  ref: MediaRef,
  preferredLang = "fr",
): Promise<RankedCandidate[]> {
  const active = sources.filter((s) => s.supports(ref));
  const results = await Promise.all(active.map((s) => s.getPosters(ref)));
  const flat = results.flat();

  return flat
    .map((c) => ({ ...c, rank: score(c, preferredLang) }))
    .sort((a, b) => b.rank - a.rank);
}

// Tri : langue préférée d'abord, puis textless (null), puis autres langues ;
// à langue égale, la popularité départage. Bornes larges pour garder l'ordre lisible.
function score(c: PosterCandidate, preferredLang: string): number {
  let langBonus: number;
  if (c.lang === preferredLang) langBonus = 2_000_000;
  else if (c.lang === null || c.lang === "00") langBonus = 1_000_000; // textless
  else if (c.lang === "en") langBonus = 500_000;
  else langBonus = 0;
  return langBonus + (c.popularity ?? 0) * 100;
}

export function activeSourceNames(ref: MediaRef): string[] {
  return sources.filter((s) => s.supports(ref)).map((s) => s.name);
}
