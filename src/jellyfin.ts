// Client Jellyfin minimal — juste ce qu'il faut pour lister la bibliothèque
// et récupérer les images. On s'authentifie via le header X-Emby-Token.

import { config } from "./config.ts";
import { listManaged } from "./db.ts";

export type MediaType = "Movie" | "Series" | "BoxSet" | "Season";

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
  /** Présence des autres types d'image (filtres « sans fond/logo/vignette »). */
  hasBackdrop: boolean;
  hasLogo: boolean;
  hasThumb: boolean;
  /** URLs par type d'image (null si absent) — pour la vue « ligne ». */
  images: Record<string, string | null>;
  /** true si le poster (Primary) est verrouillé dans posterarr. */
  locked: boolean;
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

/** URL publique d'un type d'image quelconque (Backdrop = index 0). */
function imageUrlOf(id: string, type: string, tag: string | null): string | null {
  if (!tag) return null;
  const path = type === "Backdrop" ? "Backdrop/0" : type;
  return `${config.jellyfinPublicUrl}/Items/${id}/Images/${path}?tag=${tag}&maxWidth=400&quality=80`;
}

interface JfItemsResponse {
  Items: Array<{
    Id: string;
    Name: string;
    Type: MediaType;
    ProductionYear?: number;
    ImageTags?: { Primary?: string; Logo?: string; Thumb?: string };
    BackdropImageTags?: string[];
    ProviderIds?: Record<string, string>;
    Path?: string;
  }>;
  TotalRecordCount: number;
}

/**
 * Maps du tag appliqué par posterarr (le listing bulk Jellyfin peut être périmé
 * après un refresh). Le tag managé prime : c'est le poster que posterarr gère.
 */
function buildAppliedMaps(
  imageType = "Primary",
): { byItemId: Map<string, string>; byKey: Map<string, string> } {
  const byItemId = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const m of listManaged()) {
    if (m.image_type !== imageType || !m.applied_tag) continue;
    byKey.set(m.provider_key, m.applied_tag);
    if (m.jellyfin_item_id) byItemId.set(m.jellyfin_item_id, m.applied_tag);
  }
  return { byItemId, byKey };
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

export interface LibraryImage {
  tag: string | null;
  url: string | null;
}
export interface LibraryEntry {
  id: string;
  name: string;
  collectionType: string | null;
  primary: LibraryImage;
  thumb: LibraryImage;
}

/** Bibliothèques Jellyfin (CollectionFolder) avec leurs images Primary + Thumb. */
export async function getLibraries(): Promise<LibraryEntry[]> {
  const vfs = await jf<Array<{ Name: string; ItemId: string; CollectionType?: string }>>(
    "/Library/VirtualFolders",
  );
  const ids = vfs.map((v) => v.ItemId).join(",");
  const items = ids
    ? await jf<{ Items: Array<{ Id: string; ImageTags?: Record<string, string> }> }>("/Items", {
        Ids: ids,
        EnableImageTypes: "Primary,Thumb",
      })
    : { Items: [] };
  const tagsById = new Map(items.Items.map((i) => [i.Id, i.ImageTags ?? {}]));
  const img = (id: string, type: string): LibraryImage => {
    const tag = tagsById.get(id)?.[type] ?? null;
    return {
      tag,
      url: tag
        ? `${config.jellyfinPublicUrl}/Items/${id}/Images/${type}?tag=${tag}&maxWidth=500`
        : null,
    };
  };
  return vfs.map((v) => ({
    id: v.ItemId,
    name: v.Name,
    collectionType: v.CollectionType ?? null,
    primary: img(v.ItemId, "Primary"),
    thumb: img(v.ItemId, "Thumb"),
  }));
}

/** Supprime une image d'un item Jellyfin (bibliothèque, film…). */
export async function deleteImage(itemId: string, imageType: string): Promise<void> {
  const res = await fetch(`${config.jellyfinUrl}/Items/${itemId}/Images/${imageType}`, {
    method: "DELETE",
    headers: { "X-Emby-Token": config.jellyfinApiKey },
  });
  if (!res.ok) throw new Error(`Suppression Jellyfin ${imageType} -> ${res.status}`);
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
      EnableImageTypes: "Primary,Backdrop,Logo,Thumb",
      // Sinon Jellyfin masque les films/séries appartenant à une collection.
      CollapseBoxSetItems: "false",
    }),
    getLibraryLocations(),
    getCollectionMemberIds(),
  ]);
  // Jellyfin est la source de vérité de la présence d'image : on ne surcharge
  // PAS depuis la DB managée, sinon un tag périmé (image supprimée côté Jellyfin
  // depuis) masque à tort l'item dans « Sans poster/fond/logo/vignette ».
  // Verrou du poster (Primary), depuis la DB managée.
  const lockedKeys = new Set<string>();
  const lockedIds = new Set<string>();
  for (const m of listManaged()) {
    if (m.image_type === "Primary" && m.locked) {
      lockedKeys.add(m.provider_key);
      if (m.jellyfin_item_id) lockedIds.add(m.jellyfin_item_id);
    }
  }
  return data.Items.filter((it) => {
    if (!it.Path) return true; // pas de chemin (collections…) : on garde
    return locations.some((loc) => it.Path!.startsWith(loc));
  }).map((it) => {
    const tag = it.ImageTags?.Primary ?? null;
    const key = providerKeyFromIds(it.ProviderIds);
    return {
      id: it.Id,
      name: it.Name,
      type: it.Type,
      year: it.ProductionYear ?? null,
      primaryTag: tag,
      posterUrl: posterUrl(it.Id, tag),
      inCollection: memberIds.has(it.Id),
      locked: lockedIds.has(it.Id) || (!!key && lockedKeys.has(key)),
      hasBackdrop: (it.BackdropImageTags?.length ?? 0) > 0,
      hasLogo: !!it.ImageTags?.Logo,
      hasThumb: !!it.ImageTags?.Thumb,
      images: {
        Primary: imageUrlOf(it.Id, "Primary", it.ImageTags?.Primary ?? null),
        Backdrop: imageUrlOf(it.Id, "Backdrop", it.BackdropImageTags?.[0] ?? null),
        Logo: imageUrlOf(it.Id, "Logo", it.ImageTags?.Logo ?? null),
        Thumb: imageUrlOf(it.Id, "Thumb", it.ImageTags?.Thumb ?? null),
      },
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
  /** Pour une saison : numéro (IndexNumber). tmdbId/tvdbId sont alors ceux de la série. */
  seasonNumber: number | null;
}

function toProviders(ids: Record<string, string> | undefined) {
  const m = new Map(Object.entries(ids ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    tmdbId: m.get("tmdb") ?? null,
    imdbId: m.get("imdb") ?? null,
    tvdbId: m.get("tvdb") ?? null,
  };
}

/** Résout les identifiants stables (TMDB/IMDb/TVDB) d'un item. */
export async function getItemProviders(id: string): Promise<ItemProviders> {
  const uid = await getUserId();
  const it = await jf<{
    Id: string;
    Name: string;
    Type: MediaType;
    ProviderIds?: Record<string, string>;
    SeriesId?: string;
    IndexNumber?: number;
  }>(`/Users/${uid}/Items/${id}`);

  // Une saison n'a pas d'id propre : on prend ceux de la série + son numéro.
  if (it.Type === "Season" && it.SeriesId) {
    const series = await jf<{ ProviderIds?: Record<string, string> }>(
      `/Users/${uid}/Items/${it.SeriesId}`,
    );
    return {
      id: it.Id,
      name: it.Name,
      type: "Season",
      ...toProviders(series.ProviderIds),
      seasonNumber: it.IndexNumber ?? null,
    };
  }

  return {
    id: it.Id,
    name: it.Name,
    type: it.Type,
    ...toProviders(it.ProviderIds),
    seasonNumber: null,
  };
}

/** Clé durable pour la DB : préfère TMDB, puis IMDb, puis TVDB. Null si aucun.
 * Une saison reçoit une clé distincte de sa série (suffixe :s<numéro>). */
export function providerKey(p: ItemProviders): string | null {
  const base = p.tmdbId ? `tmdb:${p.tmdbId}` : p.imdbId ? `imdb:${p.imdbId}` : p.tvdbId ? `tvdb:${p.tvdbId}` : null;
  if (!base) return null;
  if (p.type === "Season" && p.seasonNumber != null) return `${base}:s${p.seasonNumber}`;
  return base;
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

/**
 * Tag de l'image `imageType` actuelle d'un item (null si absente).
 * Backdrop est multiple côté Jellyfin (BackdropImageTags[]) : on ne gère que
 * le principal (index 0). Les autres types vivent dans ImageTags.
 */
export async function getImageTag(itemId: string, imageType: string): Promise<string | null> {
  const uid = await getUserId();
  const it = await jf<{
    ImageTags?: Record<string, string>;
    BackdropImageTags?: string[];
  }>(`/Users/${uid}/Items/${itemId}`);
  if (imageType === "Backdrop") return it.BackdropImageTags?.[0] ?? null;
  return it.ImageTags?.[imageType] ?? null;
}

export interface LibraryTarget {
  itemId: string;
  name: string;
  /** Tag Jellyfin courant par type d'image (Primary/Logo/Thumb/Banner + Backdrop[0]). */
  tags: Record<string, string | null>;
  /** Toutes les clés possibles (tmdb:/imdb:/tvdb:) pour matcher un provider_key stocké. */
  providerKeys: string[];
}

/**
 * Bibliothèque avec ProviderIds — une seule requête. Sert à la passe de guérison
 * pour retrouver l'item Jellyfin courant à partir d'un provider_key (l'ItemId a pu
 * changer après un upgrade) et détecter une dérive sur n'importe quel type d'image.
 */
export async function getLibraryTargets(): Promise<LibraryTarget[]> {
  const data = await jf<{
    Items: Array<{
      Id: string;
      Name: string;
      ProviderIds?: Record<string, string>;
      ImageTags?: Record<string, string>;
      BackdropImageTags?: string[];
    }>;
  }>("/Items", {
    Recursive: "true",
    IncludeItemTypes: "Movie,Series,BoxSet,Season",
    Fields: "ProviderIds",
    EnableImageTypes: "Primary,Backdrop,Logo,Thumb,Banner",
    CollapseBoxSetItems: "false",
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
      tags: {
        Primary: it.ImageTags?.Primary ?? null,
        Backdrop: it.BackdropImageTags?.[0] ?? null,
        Logo: it.ImageTags?.Logo ?? null,
        Thumb: it.ImageTags?.Thumb ?? null,
        Banner: it.ImageTags?.Banner ?? null,
      },
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

  // Rafraîchit les métadonnées (titre/année) sans remplacer tout (replaceAllMetadata=true
  // corrompt parfois l'index bulk de l'item) ni toucher aux images.
  await fetch(
    `${config.jellyfinUrl}/Items/${itemId}/Refresh` +
      `?metadataRefreshMode=FullRefresh&replaceAllMetadata=false` +
      `&imageRefreshMode=Default&replaceAllImages=false`,
    { method: "POST", headers: { "X-Emby-Token": config.jellyfinApiKey } },
  );
}

export interface CollectionItem {
  id: string;
  name: string;
  year: number | null;
  posterUrl: string | null;
  /** URLs par type d'image de la tête (série/collection), pour la vue « ligne ». */
  images: Record<string, string | null>;
  members: Array<{ id: string; name: string; year: number | null; posterUrl: string | null }>;
}

interface JfMember {
  Id: string;
  Name: string;
  ProductionYear?: number;
  ImageTags?: { Primary?: string; Logo?: string; Thumb?: string };
  BackdropImageTags?: string[];
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
      EnableImageTypes: "Primary,Backdrop,Logo,Thumb",
      CollapseBoxSetItems: "false",
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
  const maps = buildAppliedMaps();
  const tagFor = (id: string, bulk: string | undefined) => maps.byItemId.get(id) ?? bulk ?? null;

  const bySeries = new Map<string, CollectionItem["members"]>();
  for (const s of seasons) {
    const arr = bySeries.get(s.SeriesId) ?? [];
    arr.push({
      id: s.Id,
      name: s.Name,
      year: s.ProductionYear ?? null,
      posterUrl: posterUrl(s.Id, tagFor(s.Id, s.ImageTags?.Primary)),
    });
    bySeries.set(s.SeriesId, arr);
  }

  return seriesData.Items.filter(
    (p) => !p.Path || locations.some((loc) => p.Path!.startsWith(loc)),
  ).map((p) => ({
    id: p.Id,
    name: p.Name,
    year: p.ProductionYear ?? null,
    posterUrl: posterUrl(p.Id, tagFor(p.Id, p.ImageTags?.Primary)),
    images: {
      Primary: imageUrlOf(p.Id, "Primary", tagFor(p.Id, p.ImageTags?.Primary)),
      Backdrop: imageUrlOf(p.Id, "Backdrop", p.BackdropImageTags?.[0] ?? null),
      Logo: imageUrlOf(p.Id, "Logo", p.ImageTags?.Logo ?? null),
      Thumb: imageUrlOf(p.Id, "Thumb", p.ImageTags?.Thumb ?? null),
    },
    members: bySeries.get(p.Id) ?? [],
  }));
}

/** Saisons d'une série avec leur numéro (IndexNumber), pour l'import de set zip. */
export async function getSeasonsForZip(
  seriesId: string,
): Promise<Array<{ id: string; indexNumber: number | null }>> {
  const uid = await getUserId();
  const data = await jf<{ Items: Array<{ Id: string; IndexNumber?: number }> }>(
    `/Users/${uid}/Items`,
    { parentId: seriesId, IncludeItemTypes: "Season" },
  );
  return data.Items.map((s) => ({ id: s.Id, indexNumber: s.IndexNumber ?? null }));
}

/** Films membres d'une collection (BoxSet). `applied` = fallback tag managé par item id. */
export async function getCollectionMembers(boxsetId: string, applied?: Map<string, string>) {
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
    posterUrl: posterUrl(m.Id, applied?.get(m.Id) ?? m.ImageTags?.Primary ?? null),
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
      EnableImageTypes: "Primary,Backdrop,Logo,Thumb",
    }),
    getLibraryLocations(),
  ]);
  // Même filtre que getLibrary : écarte les orphelins (chemin hors bibliothèque).
  const parents = data.Items.filter(
    (p) => !p.Path || locations.some((loc) => p.Path!.startsWith(loc)),
  );

  const maps = buildAppliedMaps();
  // Concurrence limitée (jusqu'à ~345 séries → ne pas noyer Jellyfin).
  const out: CollectionItem[] = new Array(parents.length);
  const CONCURRENCY = 16;
  let i = 0;
  async function worker() {
    while (i < parents.length) {
      const idx = i++;
      const p = parents[idx];
      const members = await getCollectionMembers(p.Id, maps.byItemId).catch(() => []);
      out[idx] = {
        id: p.Id,
        name: p.Name,
        year: p.ProductionYear ?? null,
        posterUrl: posterUrl(p.Id, maps.byItemId.get(p.Id) ?? p.ImageTags?.Primary ?? null),
        images: {
          Primary: imageUrlOf(p.Id, "Primary", maps.byItemId.get(p.Id) ?? p.ImageTags?.Primary ?? null),
          Backdrop: imageUrlOf(p.Id, "Backdrop", p.BackdropImageTags?.[0] ?? null),
          Logo: imageUrlOf(p.Id, "Logo", p.ImageTags?.Logo ?? null),
          Thumb: imageUrlOf(p.Id, "Thumb", p.ImageTags?.Thumb ?? null),
        },
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
