import { config } from "../config.ts";
import type { ImageCandidate, ImageSource, ImageType, MediaRef } from "./types.ts";

// Fanart.tv : films indexés par TMDB/IMDb, séries par TVDB.
// Chaque type d'image Jellyfin correspond à une ou plusieurs clés JSON fanart
// (les clés HD priment mais on renvoie tout, le scoring tranche par popularité).

interface FanartImage {
  url: string;
  lang: string;
  likes: string;
}
type FanartResponse = Record<string, FanartImage[] | undefined>;

// [clés films, clés séries] pour chaque type Jellyfin.
const FANART_KEYS: Record<ImageType, { movie: string[]; tv: string[] }> = {
  Primary: { movie: ["movieposter"], tv: ["tvposter"] },
  Backdrop: { movie: ["moviebackground"], tv: ["showbackground"] },
  Logo: { movie: ["hdmovielogo", "movielogo"], tv: ["hdtvlogo", "clearlogo"] },
  Thumb: { movie: ["moviethumb"], tv: ["tvthumb"] },
  Banner: { movie: ["moviebanner"], tv: ["tvbanner"] },
};

export const fanartSource: ImageSource = {
  name: "fanart",

  supports(ref: MediaRef): boolean {
    if (!config.fanartApiKey) return false;
    if (ref.type === "Movie") return Boolean(ref.tmdbId || ref.imdbId);
    if (ref.type === "Series") return Boolean(ref.tvdbId);
    return false;
  },

  async getImages(ref: MediaRef, imageType: ImageType): Promise<ImageCandidate[]> {
    const isMovie = ref.type === "Movie";
    const id = isMovie ? (ref.tmdbId ?? ref.imdbId) : ref.tvdbId;
    const section = isMovie ? "movies" : "tv";
    const keys = FANART_KEYS[imageType][isMovie ? "movie" : "tv"];
    const url = `https://webservice.fanart.tv/v3/${section}/${id}?api_key=${config.fanartApiKey}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return []; // 404 = pas d'artwork fanart pour ce média
      const data = (await res.json()) as FanartResponse;
      const images = keys.flatMap((k) => data[k] ?? []);
      return images.map((p) => ({
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
