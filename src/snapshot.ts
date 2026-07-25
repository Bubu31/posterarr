// Snapshot : enregistre l'état courant des posters Jellyfin (films/séries) en DB
// sans les verrouiller, pour que posterarr "connaisse" les images déjà en place.
// But : une future passe de curation traite les items non verrouillés (= non traités
// manuellement dans posterarr) ; les items déjà gérés/verrouillés ne sont pas touchés.
//
// Limite du modèle DB : la clé durable est un id stable (tmdb/imdb/tvdb). Les
// collections (BoxSet) et saisons n'en ont pas → elles sont ignorées ici, comme
// elles le sont déjà par l'apply manuel par clé.

import { listManaged, setAppliedTag, upsertManaged } from "./db.ts";
import { getLibraryTargets } from "./jellyfin.ts";

export interface SnapshotReport {
  scanned: number;
  recorded: number;
  skippedExisting: number;
  skippedNoKey: number;
  skippedNoImage: number;
}

export async function snapshot(imageType = "Primary"): Promise<SnapshotReport> {
  const report: SnapshotReport = {
    scanned: 0,
    recorded: 0,
    skippedExisting: 0,
    skippedNoKey: 0,
    skippedNoImage: 0,
  };

  const known = new Set(
    listManaged()
      .filter((m) => m.image_type === imageType)
      .map((m) => m.provider_key),
  );

  const now = new Date().toISOString();
  for (const t of await getLibraryTargets()) {
    report.scanned++;
    const key = t.providerKeys[0]; // même priorité tmdb>imdb>tvdb que providerKeys
    if (!key) {
      report.skippedNoKey++;
      continue;
    }
    if (!t.tags[imageType]) {
      report.skippedNoImage++;
      continue;
    }
    if (known.has(key)) {
      report.skippedExisting++;
      continue;
    }
    // source_url null : pas d'octets stockés → la guérison ignore (locked=0 de toute
    // façon). applied_tag = tag courant, sert de base à la détection de dérive future.
    upsertManaged(key, imageType, "jellyfin", null, false, now, t.itemId);
    // applied_tag n'est pas géré par upsertManaged ; on le pose juste après.
    setAppliedTag(key, imageType, t.tags[imageType]!);
    known.add(key);
    report.recorded++;
  }
  return report;
}
