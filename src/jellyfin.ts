// Client Jellyfin minimal — juste ce qu'il faut pour lister la bibliothèque
// et récupérer les images. On s'authentifie via le header X-Emby-Token.

import { config } from "./config.ts";

export type MediaType = "Movie" | "Series" | "BoxSet";

export interface LibraryItem {
  id: string;
  name: string;
  type: MediaType;
  year: number | null;
  /** tag de l'image Primary actuelle, ou null si l'item n'a pas de poster */
  primaryTag: string | null;
  /** URL du poster actuel côté Jellyfin (proxy plus tard si besoin), ou null */
  posterUrl: string | null;
}

async function jf<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(config.jellyfinUrl + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { "X-Emby-Token": config.jellyfinApiKey } });
  if (!res.ok) {
    throw new Error(`Jellyfin ${path} -> ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Certains endpoints (/Items/{id}) exigent un contexte utilisateur sur ce serveur.
// On résout un userId une fois et on le met en cache pour la durée du process.
let cachedUserId: string | null = null;
async function getUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const users = await jf<Array<{ Id: string }>>("/Users");
  if (users.length === 0) throw new Error("Aucun utilisateur Jellyfin");
  cachedUserId = users[0].Id;
  return cachedUserId;
}

function posterUrl(id: string, tag: string | null): string | null {
  if (!tag) return null;
  // URL PUBLIQUE (chargée par le navigateur) ; maxWidth pour des vignettes légères,
  // le tag évite le cache navigateur périmé.
  return `${config.jellyfinPublicUrl}/Items/${id}/Images/Primary?tag=${tag}&maxWidth=300&quality=80`;
}

interface JfItemsResponse {
  Items: Array<{
    Id: string;
    Name: string;
    Type: MediaType;
    ProductionYear?: number;
    ImageTags?: { Primary?: string };
  }>;
  TotalRecordCount: number;
}

/** Emplacements des bibliothèques actives (pour écarter les items orphelins). */
async function getLibraryLocations(): Promise<string[]> {
  const vfs = await jf<Array<{ Locations?: string[] }>>("/Library/VirtualFolders");
  return vfs.flatMap((v) => v.Locations ?? []);
}

/**
 * Liste films, séries et collections avec l'état de leur poster actuel.
 * Écarte les items orphelins : quand une bibliothèque est supprimée dans Jellyfin,
 * ses items restent parfois dans la base (ParentId nul, chemin hors bibliothèque).
 * On ne garde que ceux dont le chemin est sous une bibliothèque active
 * (les items sans chemin, ex. collections, sont conservés).
 */
export async function getLibrary(): Promise<LibraryItem[]> {
  const [data, locations] = await Promise.all([
    jf<JfItemsResponse>("/Items", {
      Recursive: "true",
      IncludeItemTypes: "Movie,Series,BoxSet",
      Fields: "ProductionYear,Path",
      SortBy: "SortName",
      SortOrder: "Ascending",
      EnableImageTypes: "Primary",
    }),
    getLibraryLocations(),
  ]);
  return data.Items.filter((it) => {
    const path = (it as { Path?: string }).Path;
    if (!path) return true; // pas de chemin (collections…) : on garde
    return locations.some((loc) => path.startsWith(loc));
  }).map((it) => {
    const tag = it.ImageTags?.Primary ?? null;
    return {
      id: it.Id,
      name: it.Name,
      type: it.Type,
      year: it.ProductionYear ?? null,
      primaryTag: tag,
      posterUrl: posterUrl(it.Id, tag),
    };
  });
}

export interface ItemProviders {
  id: string;
  name: string;
  type: MediaType;
  tmdbId: string | null;
  imdbId: string | null;
  tvdbId: string | null;
}

/** Résout les identifiants stables (TMDB/IMDb/TVDB) d'un item. */
export async function getItemProviders(id: string): Promise<ItemProviders> {
  const uid = await getUserId();
  const it = await jf<{
    Id: string;
    Name: string;
    Type: MediaType;
    ProviderIds?: Record<string, string>;
  }>(`/Users/${uid}/Items/${id}`);
  // ProviderIds a des clés à casse variable selon les plugins (Tmdb/TMDB…)
  const providers = new Map(
    Object.entries(it.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    id: it.Id,
    name: it.Name,
    type: it.Type,
    tmdbId: providers.get("tmdb") ?? null,
    imdbId: providers.get("imdb") ?? null,
    tvdbId: providers.get("tvdb") ?? null,
  };
}

/** Clé durable pour la DB : préfère TMDB, puis IMDb, puis TVDB. Null si aucun. */
export function providerKey(p: ItemProviders): string | null {
  if (p.tmdbId) return `tmdb:${p.tmdbId}`;
  if (p.imdbId) return `imdb:${p.imdbId}`;
  if (p.tvdbId) return `tvdb:${p.tvdbId}`;
  return null;
}

/**
 * Pousse des octets d'image à un item Jellyfin. Jellyfin l'écrit en local
 * (folder.jpg) car SaveLocalMetadata=True. Le corps attendu est l'image en base64.
 */
export async function uploadImageBytes(
  itemId: string,
  imageType: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const base64 = Buffer.from(bytes).toString("base64");
  const res = await fetch(`${config.jellyfinUrl}/Items/${itemId}/Images/${imageType}`, {
    method: "POST",
    headers: { "X-Emby-Token": config.jellyfinApiKey, "Content-Type": contentType },
    body: base64,
  });
  if (!res.ok) {
    throw new Error(`Upload Jellyfin ${imageType} -> ${res.status} ${res.statusText}`);
  }
}

/** Télécharge une image depuis une URL puis la pousse à l'item. */
export async function uploadImageFromUrl(
  itemId: string,
  imageType: string,
  imageUrl: string,
): Promise<void> {
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Téléchargement image -> ${img.status}`);
  const contentType = img.headers.get("content-type") ?? "image/jpeg";
  await uploadImageBytes(itemId, imageType, await img.arrayBuffer(), contentType);
}

/** Tag de l'image Primary actuelle d'un item (null si absente). */
export async function getPrimaryTag(itemId: string): Promise<string | null> {
  const uid = await getUserId();
  const it = await jf<{ ImageTags?: { Primary?: string } }>(`/Users/${uid}/Items/${itemId}`);
  return it.ImageTags?.Primary ?? null;
}

export interface LibraryTarget {
  itemId: string;
  name: string;
  primaryTag: string | null;
  /** Toutes les clés possibles (tmdb:/imdb:/tvdb:) pour matcher un provider_key stocké. */
  providerKeys: string[];
}

/**
 * Bibliothèque avec ProviderIds — une seule requête. Sert à la passe de guérison
 * pour retrouver l'item Jellyfin courant à partir d'un provider_key (l'ItemId a pu
 * changer après un upgrade).
 */
export async function getLibraryTargets(): Promise<LibraryTarget[]> {
  const data = await jf<{
    Items: Array<{
      Id: string;
      Name: string;
      ProviderIds?: Record<string, string>;
      ImageTags?: { Primary?: string };
    }>;
  }>("/Items", {
    Recursive: "true",
    IncludeItemTypes: "Movie,Series,BoxSet",
    Fields: "ProviderIds",
    EnableImageTypes: "Primary",
  });
  return data.Items.map((it) => {
    const p = new Map(
      Object.entries(it.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const keys: string[] = [];
    if (p.get("tmdb")) keys.push(`tmdb:${p.get("tmdb")}`);
    if (p.get("imdb")) keys.push(`imdb:${p.get("imdb")}`);
    if (p.get("tvdb")) keys.push(`tvdb:${p.get("tvdb")}`);
    return {
      itemId: it.Id,
      name: it.Name,
      primaryTag: it.ImageTags?.Primary ?? null,
      providerKeys: keys,
    };
  });
}

/**
 * Écrit un TMDB id dans les ProviderIds d'un item Jellyfin, puis déclenche un
 * rafraîchissement des métadonnées (corrige le titre/année à partir du bon id).
 * Les images ne sont pas remplacées (posterarr gère les posters).
 */
export async function setTmdbId(itemId: string, tmdbId: string): Promise<void> {
  const uid = await getUserId();
  const dto = await jf<Record<string, unknown> & { ProviderIds?: Record<string, string> }>(
    `/Users/${uid}/Items/${itemId}`,
  );
  dto.ProviderIds = { ...(dto.ProviderIds ?? {}), Tmdb: tmdbId };
  const res = await fetch(`${config.jellyfinUrl}/Items/${itemId}`, {
    method: "POST",
    headers: { "X-Emby-Token": config.jellyfinApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(dto),
  });
  if (!res.ok) throw new Error(`UpdateItem -> ${res.status} ${res.statusText}`);

  // Rafraîchit les métadonnées (titre/année) sans toucher aux images.
  await fetch(
    `${config.jellyfinUrl}/Items/${itemId}/Refresh` +
      `?metadataRefreshMode=FullRefresh&replaceAllMetadata=true` +
      `&imageRefreshMode=Default&replaceAllImages=false`,
    { method: "POST", headers: { "X-Emby-Token": config.jellyfinApiKey } },
  );
}

/** Ping — vérifie que les identifiants Jellyfin fonctionnent. */
export async function ping(): Promise<{ serverName: string; version: string }> {
  const info = await jf<{ ServerName: string; Version: string }>("/System/Info");
  return { serverName: info.ServerName, version: info.Version };
}
