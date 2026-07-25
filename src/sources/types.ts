// Contrat commun à toutes les sources de posters. Ajouter une source = implémenter
// PosterSource et l'enregistrer dans index.ts — aucune autre modification.

import type { MediaType } from "../jellyfin.ts";

/** Identifiants stables d'un média, résolus depuis Jellyfin (ProviderIds). */
export interface MediaRef {
  type: MediaType;
  tmdbId: string | null;
  imdbId: string | null;
  tvdbId: string | null;
  /** Pour une saison : numéro (tmdbId/tvdbId sont ceux de la série parente). */
  seasonNumber?: number | null;
}

export interface PosterCandidate {
  source: string;
  /** Image pleine résolution à appliquer. */
  url: string;
  /** Vignette légère pour la grille (peut être identique à url). */
  thumbUrl: string;
  /** Code langue ISO 639-1 (ex. "fr"), ou null si textless/inconnu. */
  lang: string | null;
  width: number | null;
  height: number | null;
  /** Score de popularité brut de la source (votes, likes…), pour trier. */
  popularity: number | null;
}

export interface PosterSource {
  readonly name: string;
  /** false = source non configurée (clé manquante) ou média non pris en charge. */
  supports(ref: MediaRef): boolean;
  /** Renvoie les posters candidats. Ne doit jamais throw : renvoyer [] en cas d'échec. */
  getPosters(ref: MediaRef): Promise<PosterCandidate[]>;
}
