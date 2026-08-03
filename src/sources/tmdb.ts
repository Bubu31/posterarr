import { config } from "../config.ts";
import type { ImageCandidate, ImageSource, ImageType, MediaRef } from "./types.ts";

const IMG = "https://image.tmdb.org/t/p";

interface TmdbImage {
  file_path: string;
  iso_639_1: string | null;
  vote_average: number;
  width: number;
  height: number;
}
interface TmdbImages {
  posters?: TmdbImage[];
  backdrops?: TmdbImage[];
  logos?: TmdbImage[];
  stills?: TmdbImage[];
}

// Type Jellyfin -> champ de la réponse TMDB /images. Thumb/Banner : TMDB n'en a pas.
const TMDB_FIELD: Partial<Record<ImageType, keyof TmdbImages>> = {
  Primary: "posters",
  Backdrop: "backdrops",
  Logo: "logos",
};

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

export const tmdbSource: ImageSource = {
  name: "tmdb",

  supports(ref: MediaRef): boolean {
    if (!config.tmdbApiKey || ref.tmdbId === null) return false;
    if (ref.type === "Season") return ref.seasonNumber != null; // via série + numéro
    if (ref.type === "Episode") return ref.seasonNumber != null && ref.episodeNumber != null;
    return ref.type === "Movie" || ref.type === "Series" || ref.type === "BoxSet";
  },

  async getImages(ref: MediaRef, imageType: ImageType): Promise<ImageCandidate[]> {
    // Épisode : endpoint dédié /tv/{sérieTmdb}/season/{n}/episode/{m}/images (stills uniquement).
    if (ref.type === "Episode") {
      if (imageType !== "Primary") return [];
      const url =
        `https://api.themoviedb.org/3/tv/${ref.tmdbId}/season/${ref.seasonNumber}` +
        `/episode/${ref.episodeNumber}/images?api_key=${config.tmdbApiKey}`;
      try {
        const res = await fetch(url);
        if (!res.ok) return [];
        const data = (await res.json()) as TmdbImages;
        return (data.stills ?? []).map((p) => ({
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
    }

    const field = TMDB_FIELD[imageType];
    if (!field) return []; // Thumb/Banner : pas de source TMDB
    // Saison : endpoint dédié /tv/{sérieTmdb}/season/{n}/images (posters uniquement)
    const path =
      ref.type === "Season"
        ? `tv/${ref.tmdbId}/season/${ref.seasonNumber}`
        : ref.type === "Series"
          ? `tv/${ref.tmdbId}`
          : ref.type === "BoxSet"
            ? `collection/${ref.tmdbId}`
            : `movie/${ref.tmdbId}`;
    const url = `https://api.themoviedb.org/3/${path}/images?api_key=${config.tmdbApiKey}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = (await res.json()) as TmdbImages;
      return (data[field] ?? []).map((p) => ({
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
