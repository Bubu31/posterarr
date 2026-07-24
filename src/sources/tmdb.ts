import { config } from "../config.ts";
import type { MediaRef, PosterCandidate, PosterSource } from "./types.ts";

const IMG = "https://image.tmdb.org/t/p";

interface TmdbImages {
  posters: Array<{
    file_path: string;
    iso_639_1: string | null;
    vote_average: number;
    width: number;
    height: number;
  }>;
}

export interface TmdbMatch {
  tmdbId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  overview: string;
}

/** Recherche TMDB par titre (pour identifier un item que Jellyfin n'a pas matché). */
export async function searchTmdb(
  type: "Movie" | "Series",
  query: string,
  year?: number,
): Promise<TmdbMatch[]> {
  if (!config.tmdbApiKey || !query.trim()) return [];
  const kind = type === "Series" ? "tv" : "movie";
  const yearParam = year ? `&${kind === "tv" ? "first_air_date_year" : "year"}=${year}` : "";
  const url =
    `https://api.themoviedb.org/3/search/${kind}?api_key=${config.tmdbApiKey}` +
    `&language=fr-FR&query=${encodeURIComponent(query.trim())}${yearParam}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      results: Array<{
        id: number;
        title?: string;
        name?: string;
        release_date?: string;
        first_air_date?: string;
        poster_path: string | null;
        overview: string;
      }>;
    };
    return data.results.slice(0, 12).map((r) => {
      const date = r.release_date || r.first_air_date || "";
      return {
        tmdbId: String(r.id),
        title: r.title ?? r.name ?? "?",
        year: date ? Number(date.slice(0, 4)) : null,
        posterUrl: r.poster_path ? `${IMG}/w200${r.poster_path}` : null,
        overview: r.overview,
      };
    });
  } catch {
    return [];
  }
}

export const tmdbSource: PosterSource = {
  name: "tmdb",

  supports(ref: MediaRef): boolean {
    // BoxSet = collection TMDB (endpoint /collection/{id}/images)
    return Boolean(config.tmdbApiKey) && ref.tmdbId !== null &&
      (ref.type === "Movie" || ref.type === "Series" || ref.type === "BoxSet");
  },

  async getPosters(ref: MediaRef): Promise<PosterCandidate[]> {
    const kind =
      ref.type === "Series" ? "tv" : ref.type === "BoxSet" ? "collection" : "movie";
    const url = `https://api.themoviedb.org/3/${kind}/${ref.tmdbId}/images?api_key=${config.tmdbApiKey}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as TmdbImages;
      return data.posters.map((p) => ({
        source: "tmdb",
        url: `${IMG}/original${p.file_path}`,
        thumbUrl: `${IMG}/w300${p.file_path}`,
        lang: p.iso_639_1,
        width: p.width,
        height: p.height,
        popularity: p.vote_average,
      }));
    } catch {
      return [];
    }
  },
};
