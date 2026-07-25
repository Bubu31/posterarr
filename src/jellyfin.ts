// Client Jellyfin minimal — juste ce qu'il faut pour lister la bibliothèque
// et récupérer les images. On s'authentifie via le header X-Emby-Token.

import { config } from "./config.ts";
import { listManaged } from "./db.ts";

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
  /** true si le film appartient à une collection (BoxSet) — pour filtrer l'onglet Films. */
  inCollection: boolean;
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
    ProviderIds?: Record<string, string>;
    Path?: string;
  }>;
  TotalRecordCount: number;
}

function providerKeyFromIds(ids: Record<string, string> | undefined): string | null {
  const p = new Map(Object.entries(ids ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (p.get("tmdb")) return `tmdb:${p.get("tmdb")}`;
  if (p.get("imdb")) return `imdb:${p.get("imdb")}`;
  if (p.get("tvdb")) return `tvdb:${p.get("tvdb")}`;
  return null;
}

/** Emplacements des bibliothèques actives (pour écarter les items orphelins). */
async function getLibraryLocations(): Promise<string[]> {
  const vfs = await jf<Array<{ Locations?: string[] }>>("/Library/VirtualFolders");
  return vfs.flatMap((v) => v.Locations ?? []);
}

// Ensemble des ids de films appartenant à une collection (BoxSet). Mis en cache
// (les collections changent peu) pour ne pas refaire ~186 requêtes à chaque /api/library.
let memberCache: { ids: Set<string>; at: number } | null = null;
const MEMBER_TTL_MS = 5 * 60_000;

async function getCollectionMemberIds(): Promise<Set<string>> {
  if (memberCache && Date.now() - memberCache.at < MEMBER_TTL_MS) return memberCache.ids;
  const uid = await getUserId();
  const boxsets = await jf<{ Items: Array<{ Id: string }> }>("/Items", {
    Recursive: "true",
    IncludeItemTypes: "BoxSet",
  });
  const ids = new Set<string>();
  const CONCURRENCY = 8;
  let i = 0;
  async function worker() {
    while (i < boxsets.Items.length) {
      const bs = boxsets.Items[i++];
      try {
        const m = await jf<{ Items: Array<{ Id: string }> }>(`/Users/${uid}/Items`, {
          parentId: bs.Id,
        });
        for (const it of m.Items) ids.add(it.Id);
      } catch {
        /* collection illisible : on ignore */
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  memberCache = { ids, at: Date.now() };
  return ids;
}

/**
 * Liste films, séries et collections avec l'état de leur poster actuel.
 * Écarte les items orphelins : quand une bibliothèque est supprimée dans Jellyfin,
 * ses items restent parfois dans la base (ParentId nul, chemin hors bibliothèque).
 * On ne garde que ceux dont le chemin est sous une bibliothèque active
 * (les items sans chemin, ex. collections, sont conservés).
 */
export async function getLibrary(): Promise<LibraryItem[]> {
  const [data, locations, memberIds] = await Promise.all([
    jf<JfItemsResponse>("/Items", {
      Recursive: "true",
      IncludeItemTypes: "Movie,Series,BoxSet",
      Fields: "ProductionYear,Path,ProviderIds",
      SortBy: "SortName",
      SortOrder: "Ascending",
      EnableImageTypes: "Primary",
    }),
    getLibraryLocations(),
    getCollectionMemberIds(),
  ]);
  // Fallback : le listing bulk Jellyfin renvoie parfois ImageTags vide après un
  // refresh de métadonnées, alors que posterarr a bien appliqué un poster. On
  // récupère alors le tag depuis notre DB (applied_tag) pour l'afficher quand même.
  const appliedByKey = new Map<string, string>();
  for (const m of listManaged()) {
    if (m.image_type === "Primary" && m.applied_tag) appliedByKey.set(m.provider_key, m.applied_tag);
  }
  return data.Items.filter((it) => {
    if (!it.Path) return true; // pas de chemin (collections…) : on garde
    return locations.some((loc) => it.Path!.startsWith(loc));
  }).map((it) => {
    const key = providerKeyFromIds(it.ProviderIds);
    const tag = it.ImageTags?.Primary ?? (key ? appliedByKey.get(key) ?? null : null);
    return {
      id: it.Id,
      name: it.Name,
      type: it.Type,
      year: it.ProductionYear ?? null,
      primaryTag: tag,
      posterUrl: posterUrl(it.Id, tag),
      inCollection: memberIds.has(it.Id),
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

export interface CollectionItem {
  id: string;
  name: string;
  year: number | null;
  posterUrl: string | null;
  members: Array<{ id: string; name: string; year: number | null; posterUrl: string | null }>;
}

interface JfMember {
  Id: string;
  Name: string;
  ProductionYear?: number;
  ImageTags?: { Primary?: string };
}

/**
 * Séries avec leurs saisons — optimisé en 2 requêtes (les saisons portent leur
 * SeriesId, donc on récupère toutes les saisons d'un coup et on les regroupe,
 * au lieu d'une requête par série).
 */
export async function getSeries(): Promise<CollectionItem[]> {
  const [seriesData, locations, seasonsData] = await Promise.all([
    jf<{ Items: Array<JfMember & { Path?: string }> }>("/Items", {
      Recursive: "true",
      IncludeItemTypes: "Series",
      Fields: "ProductionYear,Path",
      SortBy: "SortName",
      SortOrder: "Ascending",
      EnableImageTypes: "Primary",
    }),
    getLibraryLocations(),
    jf<{ Items: Array<JfMember & { SeriesId: string; IndexNumber?: number }> }>("/Items", {
      Recursive: "true",
      IncludeItemTypes: "Season",
      Fields: "ProductionYear",
      EnableImageTypes: "Primary",
    }),
  ]);

  // Tri par numéro de saison (Saison 2 avant Saison 10) avant regroupement.
  const seasons = seasonsData.Items.slice().sort(
    (a, b) => (a.IndexNumber ?? 999) - (b.IndexNumber ?? 999),
  );
  const bySeries = new Map<string, CollectionItem["members"]>();
  for (const s of seasons) {
    const arr = bySeries.get(s.SeriesId) ?? [];
    arr.push({
      id: s.Id,
      name: s.Name,
      year: s.ProductionYear ?? null,
      posterUrl: posterUrl(s.Id, s.ImageTags?.Primary ?? null),
    });
    bySeries.set(s.SeriesId, arr);
  }

  return seriesData.Items.filter(
    (p) => !p.Path || locations.some((loc) => p.Path!.startsWith(loc)),
  ).map((p) => ({
    id: p.Id,
    name: p.Name,
    year: p.ProductionYear ?? null,
    posterUrl: posterUrl(p.Id, p.ImageTags?.Primary ?? null),
    members: bySeries.get(p.Id) ?? [],
  }));
}

/** Films membres d'une collection (BoxSet). */
export async function getCollectionMembers(boxsetId: string) {
  const uid = await getUserId();
  const data = await jf<{ Items: JfMember[] }>(`/Users/${uid}/Items`, {
    parentId: boxsetId,
    Fields: "ProductionYear",
    SortBy: "ProductionYear,SortName",
    SortOrder: "Ascending",
    EnableImageTypes: "Primary",
  });
  return data.Items.map((m) => ({
    id: m.Id,
    name: m.Name,
    year: m.ProductionYear ?? null,
    posterUrl: posterUrl(m.Id, m.ImageTags?.Primary ?? null),
  }));
}

/**
 * Groupes (parents) avec leurs enfants, pour la vue liste. Fonctionne pour les
 * collections (BoxSet → films) comme pour les séries (Series → saisons) : dans les
 * deux cas les enfants se récupèrent via parentId.
 */
// Cache des collections (N+1 inhérent : 186 requêtes). Invalidé après tout apply
// pour ne pas afficher un poster périmé.
let boxsetGroupsCache: { data: CollectionItem[]; at: number } | null = null;
const GROUPS_TTL_MS = 10 * 60_000;

/** À appeler après tout changement de poster/identifiant : purge les caches dérivés. */
export function invalidateGroupsCache(): void {
  boxsetGroupsCache = null;
  memberCache = null;
}

export async function getGroups(includeItemType: "BoxSet" | "Series"): Promise<CollectionItem[]> {
  if (
    includeItemType === "BoxSet" &&
    boxsetGroupsCache &&
    Date.now() - boxsetGroupsCache.at < GROUPS_TTL_MS
  ) {
    return boxsetGroupsCache.data;
  }
  const [data, locations] = await Promise.all([
    jf<{ Items: Array<JfMember & { Path?: string }> }>("/Items", {
      Recursive: "true",
      IncludeItemTypes: includeItemType,
      Fields: "ProductionYear,Path",
      SortBy: "SortName",
      SortOrder: "Ascending",
      EnableImageTypes: "Primary",
    }),
    getLibraryLocations(),
  ]);
  // Même filtre que getLibrary : écarte les orphelins (chemin hors bibliothèque).
  const parents = data.Items.filter(
    (p) => !p.Path || locations.some((loc) => p.Path!.startsWith(loc)),
  );

  // Concurrence limitée (jusqu'à ~345 séries → ne pas noyer Jellyfin).
  const out: CollectionItem[] = new Array(parents.length);
  const CONCURRENCY = 16;
  let i = 0;
  async function worker() {
    while (i < parents.length) {
      const idx = i++;
      const p = parents[idx];
      const members = await getCollectionMembers(p.Id).catch(() => []);
      out[idx] = {
        id: p.Id,
        name: p.Name,
        year: p.ProductionYear ?? null,
        posterUrl: posterUrl(p.Id, p.ImageTags?.Primary ?? null),
        members,
      };
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (includeItemType === "BoxSet") boxsetGroupsCache = { data: out, at: Date.now() };
  return out;
}

/** Ping — vérifie que les identifiants Jellyfin fonctionnent. */
export async function ping(): Promise<{ serverName: string; version: string }> {
  const info = await jf<{ ServerName: string; Version: string }>("/System/Info");
  return { serverName: info.ServerName, version: info.Version };
}
