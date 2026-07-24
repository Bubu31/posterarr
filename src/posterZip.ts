// Applique un set ThePosterDB (zip) à une collection et ses films.
// Format du zip : "<Titre> (<Année>).png" pour les films, "<Nom> Collection.png"
// (sans année) pour le poster de collection. On matche les films par ANNÉE parmi
// les membres de la collection — fiable malgré les titres FR vs EN du zip.

import { unzipSync } from "fflate";
import { applyBytesToItem } from "./applyPoster.ts";

export interface ZipReport {
  applied: Array<{ target: string; file: string; kind: "collection" | "movie" }>;
  unmatched: string[];
}

interface Member {
  id: string;
  name: string;
  year: number | null;
}

function contentTypeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/** Extrait l'année d'un nom "Titre (1972).png" ; null si absente (= poster de collection). */
function yearFromName(name: string): number | null {
  const m = name.match(/\((\d{4})\)/);
  return m ? Number(m[1]) : null;
}

export async function applyPosterZip(
  collectionId: string,
  members: Member[],
  zipBytes: Uint8Array,
): Promise<ZipReport> {
  const files = unzipSync(zipBytes);
  const report: ZipReport = { applied: [], unmatched: [] };

  // Index année -> membre (pour matcher les films). On ignore les années en doublon
  // pour ne pas appliquer au mauvais film.
  const byYear = new Map<number, Member | null>();
  for (const m of members) {
    if (m.year == null) continue;
    byYear.set(m.year, byYear.has(m.year) ? null : m);
  }

  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.(png|jpe?g|webp)$/i.test(name) || bytes.length === 0) continue;
    const base = name.split("/").pop() ?? name;
    const year = yearFromName(base);
    const ct = contentTypeFromName(base);
    // ArrayBuffer propre (copie) pour Jellyfin/stockage
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    try {
      if (year == null) {
        // poster de collection
        await applyBytesToItem(collectionId, "Primary", ab, ct, "thePosterDB");
        report.applied.push({ target: "Collection", file: base, kind: "collection" });
      } else {
        const member = byYear.get(year);
        if (!member) {
          report.unmatched.push(base);
          continue;
        }
        await applyBytesToItem(member.id, "Primary", ab, ct, "thePosterDB");
        report.applied.push({ target: member.name, file: base, kind: "movie" });
      }
    } catch {
      report.unmatched.push(base);
    }
  }
  return report;
}
