// Passe de guérison : pour chaque item verrouillé, vérifie que le poster Jellyfin
// est toujours celui qu'on a appliqué. S'il a disparu ou a été remplacé (tag != tag
// stocké), on le ré-applique depuis source_url. Idempotent : après ré-application,
// le tag stocké est mis à jour, donc plus rien à faire tant que rien ne change.

import { addHistory, listLocked, setAppliedTag } from "./db.ts";
import {
  getLibraryTargets,
  getPrimaryTag,
  uploadImageBytes,
  uploadImageFromUrl,
} from "./jellyfin.ts";
import { readCustom } from "./customStore.ts";

export interface HealReport {
  checked: number;
  healed: Array<{ providerKey: string; name: string; reason: "missing" | "changed" }>;
  notFound: string[]; // provider_keys sans item Jellyfin correspondant (média retiré ?)
  errors: Array<{ providerKey: string; error: string }>;
}

let running = false;

export async function heal(): Promise<HealReport> {
  if (running) throw new Error("Une guérison est déjà en cours");
  running = true;
  const report: HealReport = { checked: 0, healed: [], notFound: [], errors: [] };
  try {
    const locked = listLocked();
    // Index provider_key -> cible Jellyfin (une seule requête bibliothèque).
    const index = new Map<string, Awaited<ReturnType<typeof getLibraryTargets>>[number]>();
    for (const t of await getLibraryTargets()) {
      for (const k of t.providerKeys) index.set(k, t);
    }

    for (const m of locked) {
      report.checked++;
      const target = index.get(m.provider_key);
      if (!target) {
        report.notFound.push(m.provider_key);
        continue;
      }
      const drifted =
        target.primaryTag === null
          ? "missing"
          : m.applied_tag && target.primaryTag !== m.applied_tag
            ? "changed"
            : null;
      if (!drifted) continue;
      if (!m.source_url) continue; // aucune source à ré-appliquer

      try {
        if (m.source === "custom") {
          const { bytes, contentType } = await readCustom(m.source_url);
          await uploadImageBytes(target.itemId, m.image_type, bytes, contentType);
        } else {
          await uploadImageFromUrl(target.itemId, m.image_type, m.source_url);
        }
        const newTag = await getPrimaryTag(target.itemId);
        setAppliedTag(m.provider_key, m.image_type, newTag);
        addHistory(m.provider_key, m.image_type, "heal", m.source, m.source_url, new Date().toISOString());
        report.healed.push({ providerKey: m.provider_key, name: target.name, reason: drifted });
      } catch (e) {
        report.errors.push({ providerKey: m.provider_key, error: String(e) });
      }
    }
    return report;
  } finally {
    running = false;
  }
}
