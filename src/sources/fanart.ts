import { config } from "../config.ts";
import type { MediaRef, PosterCandidate, PosterSource } from "./types.ts";

// Fanart.tv : films indexés par TMDB/IMDb, séries par TVDB.
// Champs posters : "movieposter" / "tvposter", chacun {url, lang, likes}.

interface FanartResponse {
  movieposter?: FanartImage[];
  tvposter?: FanartImage[];
}
interface FanartImage {
  url: string;
  lang: string;
  likes: string;
}

export const fanartSource: PosterSource = {
  name: "fanart",

  supports(ref: MediaRef): boolean {
    if (!config.fanartApiKey) return false;
    if (ref.type === "Movie") return Boolean(ref.tmdbId || ref.imdbId);
    if (ref.type === "Series") return Boolean(ref.tvdbId);
    return false;
  },

  async getPosters(ref: MediaRef): Promise<PosterCandidate[]> {
    const isMovie = ref.type === "Movie";
    const id = isMovie ? (ref.tmdbId ?? ref.imdbId) : ref.tvdbId;
    const section = isMovie ? "movies" : "tv";
    const url = `https://webservice.fanart.tv/v3/${section}/${id}?api_key=${config.fanartApiKey}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return []; // 404 = pas d'artwork fanart pour ce média
      const data = (await res.json()) as FanartResponse;
      const posters = (isMovie ? data.movieposter : data.tvposter) ?? [];
      return posters.map((p) => ({
        source: "fanart",
        url: p.url,
        // fanart sert des previews en /preview/ ; sinon on réutilise l'URL pleine
        thumbUrl: p.url.replace("/fanart/", "/preview/"),
        lang: p.lang || null,
        width: null,
        height: null,
        popularity: Number(p.likes) || 0,
      }));
    } catch {
      return [];
    }
  },
};
