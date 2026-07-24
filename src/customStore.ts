// Stockage local des posters custom (upload manuel). On garde les octets sur disque
// pour que la passe de guérison puisse les ré-appliquer après un upgrade — un custom
// n'a pas d'URL source à re-télécharger, contrairement à TMDB/Fanart.
// Les fichiers vivent à côté de la DB (même volume /data en prod), donc persistants.

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const dataDir = dirname(process.env.DB_PATH ?? "posterarr.db");
const customDir = join(dataDir, "custom");
mkdirSync(customDir, { recursive: true });

const EXT_TO_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function extFromContentType(ct: string): string {
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  return "jpg";
}

/** Nom de fichier sûr à partir du provider_key (ex. "tmdb:149" -> "tmdb_149"). */
function safeName(providerKey: string, imageType: string, ext: string): string {
  const base = `${providerKey}_${imageType}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${base}.${ext}`;
}

/** Écrit l'image custom et renvoie un marqueur relatif stocké en DB (source_url). */
export async function saveCustom(
  providerKey: string,
  imageType: string,
  bytes: ArrayBuffer,
  ext: string,
): Promise<string> {
  const file = safeName(providerKey, imageType, ext);
  await Bun.write(join(customDir, file), bytes);
  return `custom/${file}`; // marqueur relatif, résolu par readCustom
}

/** Relit une image custom depuis son marqueur pour ré-application (guérison). */
export async function readCustom(
  marker: string,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const file = marker.replace(/^custom\//, "");
  const ext = file.split(".").pop() ?? "jpg";
  const bytes = await Bun.file(join(customDir, file)).arrayBuffer();
  return { bytes, contentType: EXT_TO_TYPE[ext] ?? "image/jpeg" };
}
