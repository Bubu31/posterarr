// Remplissage auto depuis Fanart : pour chaque item (film/série) dont un type
// d'image manque côté Jellyfin, applique le PREMIER candidat Fanart de ce type.
// Non verrouillé (source='fanart') : reste curable manuellement ensuite.
//
// Fanart n'indexe que films (tmdb/imdb) et séries (tvdb) ; collections/saisons
// sont ignorées (getLibrary ne liste pas les saisons, et fanart.supports() est
// faux pour BoxSet).

import { addHistory, setAppliedTag, upsertManaged } from "./db.ts";
import {
  getImageTag,
  getItemProviders,
  getLibrary,
  invalidateGroupsCache,
  providerKey,
  uploadImageFromUrl,
} from "./jellyfin.ts";
import { getCandidates } from "./sources/index.ts";
import type { ImageType } from "./sources/types.ts";

export interface AutofillReport {
  itemsScanned: number;
  applied: Record<string, number>; // par type d'image
  noFanart: number; // (item,type) manquants sans candidat fanart
  errors: Array<{ item: string; type: string; error: string }>;
}

let running = false;

/** `types` = types d'image à remplir. `lock` = verrouiller les applications. */
export async function autofill(
  types: ImageType[] = ["Primary", "Backdrop", "Logo", "Thumb"],
  lock = false,
): Promise<AutofillReport> {
  if (running) throw new Error("Un remplissage auto est déjà en cours");
  running = true;
  const report: AutofillReport = { itemsScanned: 0, applied: {}, noFanart: 0, errors: [] };
  for (const t of types) report.applied[t] = 0;

  try {
    const library = await getLibrary();
    // Ne garder que les items à qui il manque au moins un des types demandés.
    const misses = (i: (typeof library)[number], t: ImageType) =>
      t === "Primary" ? !i.posterUrl
      : t === "Backdrop" ? !i.hasBackdrop
      : t === "Logo" ? !i.hasLogo
      : t === "Thumb" ? !i.hasThumb
      : false;
    const targets = library.filter((i) => types.some((t) => misses(i, t)));

    const CONCURRENCY = 6;
    let idx = 0;
    async function worker() {
      while (idx < targets.length) {
        const item = targets[idx++];
        report.itemsScanned++;
        let providers;
        try {
          providers = await getItemProviders(item.id);
        } catch (e) {
          report.errors.push({ item: item.name, type: "-", error: String(e) });
          continue;
        }
        const key = providerKey(providers);
        if (!key) continue; // sans id stable : rien à gérer
        const ref = {
          type: providers.type,
          tmdbId: providers.tmdbId,
          imdbId: providers.imdbId,
          tvdbId: providers.tvdbId,
          seasonNumber: providers.seasonNumber,
        };

        for (const type of types) {
          if (!misses(item, type)) continue;
          try {
            const candidates = await getCandidates(ref, type);
            const fanart = candidates.find((c) => c.source === "fanart");
            if (!fanart) {
              report.noFanart++;
              continue;
            }
            await uploadImageFromUrl(providers.id, type, fanart.url);
            const now = new Date().toISOString();
            upsertManaged(key, type, "fanart", fanart.url, lock, now, providers.id);
            setAppliedTag(key, type, await getImageTag(providers.id, type));
            addHistory(key, type, "apply", "fanart", fanart.url, now);
            report.applied[type]++;
          } catch (e) {
            report.errors.push({ item: item.name, type, error: String(e) });
          }
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    invalidateGroupsCache();
    return report;
  } finally {
    running = false;
  }
}
