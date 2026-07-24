// Applique des octets d'image à un item : stocke localement (guérissable),
// pousse à Jellyfin, enregistre en DB (locké). Partagé par l'upload custom et le zip.

import { addHistory, getManaged, setAppliedTag, upsertManaged } from "./db.ts";
import { extFromContentType, saveCustom } from "./customStore.ts";
import {
  getItemProviders,
  getPrimaryTag,
  providerKey,
  uploadImageBytes,
} from "./jellyfin.ts";

export async function applyBytesToItem(
  itemId: string,
  imageType: string,
  bytes: ArrayBuffer,
  contentType: string,
  source: string,
) {
  const providers = await getItemProviders(itemId);
  const key = providerKey(providers);
  if (!key) throw new Error("Item sans identifiant stable (TMDB/IMDb/TVDB)");

  const marker = await saveCustom(key, imageType, bytes, extFromContentType(contentType));
  await uploadImageBytes(providers.id, imageType, bytes, contentType);

  const now = new Date().toISOString();
  upsertManaged(key, imageType, source, marker, true, now);
  setAppliedTag(key, imageType, await getPrimaryTag(providers.id));
  addHistory(key, imageType, "apply", source, marker, now);
  return getManaged(key, imageType);
}
