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

export const tmdbSource: PosterSource = {
  name: "tmdb",

  supports(ref: MediaRef): boolean {
    return Boolean(config.tmdbApiKey) && ref.tmdbId !== null &&
      (ref.type === "Movie" || ref.type === "Series");
  },

  async getPosters(ref: MediaRef): Promise<PosterCandidate[]> {
    const kind = ref.type === "Series" ? "tv" : "movie";
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
