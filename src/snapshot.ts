// Snapshot : fige l'état courant des images Jellyfin (films/séries) en DB en les
// VERROUILLANT. But : marquer/protéger tout ce qui a déjà une image (la guérison
// les restaure), pour que seul le manquant reste à traiter.
//
// - Item déjà en DB (ex. auto-rempli) : on le (re)verrouille sans écraser sa source.
// - Item inconnu : on l'enregistre (source='jellyfin', pas d'octets) et on verrouille.
//
// Limite : clé durable = id stable (tmdb/imdb/tvdb). Collections (BoxSet) et
// saisons n'en ont pas → ignorées.

import { listManaged, setAppliedTag, setLock, upsertManaged } from "./db.ts";
import { getLibraryTargets } from "./jellyfin.ts";
import { IMAGE_TYPES, type ImageType } from "./sources/types.ts";

export interface SnapshotReport {
  scanned: number;
  recorded: number; // (item,type) nouveaux enregistrés
  relocked: number; // (item,type) déjà gérés, re-verrouillés
  skippedNoKey: number; // items sans id stable
}

const SNAPSHOT_TYPES: ImageType[] = ["Primary", "Backdrop", "Logo", "Thumb"];

export async function snapshot(types: ImageType[] = SNAPSHOT_TYPES): Promise<SnapshotReport> {
  const wanted = types.filter((t) => IMAGE_TYPES.includes(t));
  const report: SnapshotReport = { scanned: 0, recorded: 0, relocked: 0, skippedNoKey: 0 };

  // (provider_key|image_type) déjà en DB.
  const known = new Set(listManaged().map((m) => `${m.provider_key}|${m.image_type}`));

  const now = new Date().toISOString();
  for (const t of await getLibraryTargets()) {
    report.scanned++;
    const key = t.providerKeys[0];
    if (!key) {
      report.skippedNoKey++;
      continue;
    }
    for (const type of wanted) {
      if (!t.tags[type]) continue; // pas d'image de ce type → rien à figer
      if (known.has(`${key}|${type}`)) {
        setLock(key, type, true); // déjà géré : on verrouille sans toucher la source
        report.relocked++;
      } else {
        upsertManaged(key, type, "jellyfin", null, true, now, t.itemId);
        setAppliedTag(key, type, t.tags[type]!);
        known.add(`${key}|${type}`);
        report.recorded++;
      }
    }
  }
  return report;
}
