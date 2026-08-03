import { Hono } from "hono";
import { config } from "./config.ts";
import {
  getCollectionMembers,
  getGroups,
  getSeasonsForZip,
  getSeries,
  getSport,
  getEpisodes,
  getImageTag,
  getItemProviders,
  getLibrary,
  invalidateGroupsCache,
  ping,
  providerKey,
  setTmdbId,
  uploadImageFromUrl,
  uploadImageBytes,
  getLibraries,
  deleteImage,
} from "./jellyfin.ts";
import { activeSourceNames, getCandidates } from "./sources/index.ts";
import { IMAGE_TYPES, type ImageType } from "./sources/types.ts";
import { searchTmdb } from "./sources/tmdb.ts";

/** Valide un imageType venu de la requête ; défaut Primary. */
function parseImageType(raw: string | undefined): ImageType {
  return IMAGE_TYPES.includes(raw as ImageType) ? (raw as ImageType) : "Primary";
}
import { addHistory, getManaged, setAppliedTag, setLock, upsertManaged } from "./db.ts";
import { applyBytesToItem } from "./applyPoster.ts";
import { applyPosterZip, applySeriesZip } from "./posterZip.ts";
import { heal } from "./healer.ts";
import { snapshot } from "./snapshot.ts";
import { autofill } from "./autofill.ts";

const app = new Hono();

app.get("/api/health", async (c) => {
  try {
    const info = await ping();
    return c.json({ ok: true, jellyfin: info });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 502);
  }
});

app.get("/api/library", async (c) => {
  const items = await getLibrary();
  return c.json({ count: items.length, items });
});

// Collections avec leurs films (vue liste dédiée).
app.get("/api/collections", async (c) => {
  const collections = await getGroups("BoxSet");
  return c.json({ count: collections.length, collections });
});

// Séries avec leurs saisons (vue liste dédiée, même format que les collections).
app.get("/api/series", async (c) => {
  const collections = await getSeries();
  return c.json({ count: collections.length, collections });
});

// Sport (bibliothèque Jellyfin dédiée, organisée en séries+saisons).
app.get("/api/sport", async (c) => {
  const collections = await getSport();
  return c.json({ count: collections.length, collections });
});

// Épisodes d'une saison (gestion du visuel par épisode).
app.get("/api/seasons/:id/episodes", async (c) => {
  const episodes = await getEpisodes(c.req.param("id"));
  return c.json({ count: episodes.length, episodes });
});

// Candidats de posters pour un item : résout ses ProviderIds puis interroge les sources.
app.get("/api/items/:id/candidates", async (c) => {
  const imageType = parseImageType(c.req.query("imageType"));
  const providers = await getItemProviders(c.req.param("id"));
  const ref = {
    type: providers.type,
    tmdbId: providers.tmdbId,
    imdbId: providers.imdbId,
    tvdbId: providers.tvdbId,
    seasonNumber: providers.seasonNumber,
    episodeNumber: providers.episodeNumber,
  };
  const candidates = await getCandidates(ref, imageType);
  const key = providerKey(providers);
  // Image actuellement en place côté Jellyfin pour ce type (null si aucune).
  const currentTag = await getImageTag(providers.id, imageType);
  const imgPath = imageType === "Backdrop" ? "Backdrop/0" : imageType;
  const current = currentTag
    ? {
        tag: currentTag,
        url: `${config.jellyfinPublicUrl}/Items/${providers.id}/Images/${imgPath}?tag=${currentTag}&maxWidth=400&quality=80`,
      }
    : null;
  return c.json({
    item: providers,
    imageType,
    current,
    managed: key ? getManaged(key, imageType) : null,
    sources: activeSourceNames(ref),
    count: candidates.length,
    candidates,
  });
});

// Applique un poster choisi à l'item + enregistre l'état. Locke par défaut
// (choix manuel = intention explicite de garder ce poster).
app.post("/api/items/:id/apply", async (c) => {
  const body = await c.req.json<{
    url: string;
    source: string;
    imageType?: string;
    lock?: boolean;
  }>();
  const imageType = parseImageType(body.imageType);
  const lock = body.lock ?? true;

  const providers = await getItemProviders(c.req.param("id"));
  const key = providerKey(providers);
  if (!key) return c.json({ error: "Item sans identifiant stable (TMDB/IMDb/TVDB)" }, 422);

  await uploadImageFromUrl(providers.id, imageType, body.url);

  const now = new Date().toISOString();
  upsertManaged(key, imageType, body.source, body.url, lock, now, providers.id);
  // Mémorise le tag résultant pour détecter une dérive future (guérison).
  setAppliedTag(key, imageType, await getImageTag(providers.id, imageType));
  addHistory(key, imageType, "apply", body.source, body.url, now);
  invalidateGroupsCache();

  return c.json({ ok: true, managed: getManaged(key, imageType) });
});

// Upload d'un poster custom (multipart). Stocké localement (guérissable) + locké.
app.post("/api/items/:id/apply-file", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "Fichier 'file' manquant" }, 400);
  const imageType = parseImageType(
    typeof form["imageType"] === "string" ? form["imageType"] : undefined,
  );

  try {
    const managed = await applyBytesToItem(
      c.req.param("id"),
      imageType,
      await file.arrayBuffer(),
      file.type || "image/jpeg",
      "custom",
    );
    return c.json({ ok: true, managed });
  } catch (e) {
    return c.json({ error: String(e) }, 422);
  }
});

// Applique un set ThePosterDB (zip) à une collection + ses films (match par année).
app.post("/api/collections/:id/apply-zip", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "Zip 'file' manquant" }, 400);

  const members = await getCollectionMembers(c.req.param("id"));
  const zipBytes = new Uint8Array(await file.arrayBuffer());
  const report = await applyPosterZip(c.req.param("id"), members, zipBytes);
  return c.json({ ok: true, ...report });
});

// Applique un set ThePosterDB (zip) à une série + ses saisons (match par numéro).
app.post("/api/series/:id/apply-zip", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "Zip 'file' manquant" }, 400);

  const seasons = await getSeasonsForZip(c.req.param("id"));
  const zipBytes = new Uint8Array(await file.arrayBuffer());
  const report = await applySeriesZip(c.req.param("id"), seasons, zipBytes);
  return c.json({ ok: true, ...report });
});

// Verrouille / déverrouille un item (sans changer le poster).
app.post("/api/items/:id/lock", async (c) => {
  const body = await c.req.json<{ locked: boolean; imageType?: string }>();
  const imageType = parseImageType(body.imageType);
  const providers = await getItemProviders(c.req.param("id"));
  const key = providerKey(providers);
  if (!key) return c.json({ error: "Item sans identifiant stable" }, 422);
  if (!getManaged(key, imageType)) {
    return c.json({ error: "Item non géré (applique un poster d'abord)" }, 409);
  }
  setLock(key, imageType, body.locked);
  addHistory(key, imageType, body.locked ? "lock" : "unlock", null, null, new Date().toISOString());
  return c.json({ ok: true, managed: getManaged(key, imageType) });
});

// Recherche TMDB pour identifier un item que Jellyfin n'a pas matché.
app.get("/api/tmdb/search", async (c) => {
  const type = c.req.query("type") === "Series" ? "Series" : "Movie";
  const query = c.req.query("query") ?? "";
  const yearRaw = c.req.query("year");
  const year = yearRaw ? Number(yearRaw) : undefined;
  const results = await searchTmdb(type, query, Number.isNaN(year) ? undefined : year);
  return c.json({ results });
});

// Associe un TMDB id à un item (écrit dans Jellyfin + refresh métadonnées).
app.post("/api/items/:id/set-tmdb", async (c) => {
  const body = await c.req.json<{ tmdbId: string }>();
  if (!body.tmdbId) return c.json({ error: "tmdbId manquant" }, 400);
  await setTmdbId(c.req.param("id"), body.tmdbId);
  invalidateGroupsCache();
  return c.json({ ok: true });
});

// Lance une passe de guérison à la demande.
app.post("/api/heal", async (c) => {
  try {
    return c.json(await heal());
  } catch (e) {
    return c.json({ error: String(e) }, 409);
  }
});

// Enregistre l'état courant des posters (films/séries) en DB, non verrouillé.
app.post("/api/snapshot", async (c) => {
  const report = await snapshot();
  return c.json({ ok: true, ...report });
});

// Liste des bibliothèques Jellyfin + leur image actuelle.
app.get("/api/libraries", async (c) => {
  const libraries = await getLibraries();
  return c.json({ count: libraries.length, libraries });
});

// Applique une image (upload) à une bibliothèque Jellyfin. Pas de gestion DB
// (une bibliothèque n'a pas d'identifiant stable TMDB/IMDb/TVDB).
app.post("/api/libraries/:id/apply-file", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "Fichier 'file' manquant" }, 400);
  const imageType = parseImageType(
    typeof form["imageType"] === "string" ? form["imageType"] : undefined,
  );
  try {
    await uploadImageBytes(
      c.req.param("id"),
      imageType,
      await file.arrayBuffer(),
      file.type || "image/jpeg",
    );
    invalidateGroupsCache();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) }, 422);
  }
});

// Supprime une image (Primary/Thumb) d'une bibliothèque Jellyfin.
app.delete("/api/libraries/:id/images/:type", async (c) => {
  const imageType = parseImageType(c.req.param("type"));
  try {
    await deleteImage(c.req.param("id"), imageType);
    invalidateGroupsCache();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) }, 422);
  }
});

// Proxy same-origin d'une image distante, pour dessiner sur un <canvas> sans le
// "tainter" (CORS). Restreint à Jellyfin + sources d'artwork connues.
const PROXY_HOSTS = ["image.tmdb.org", "fanart.tv", "webservice.fanart.tv", "assets.fanart.tv"];
app.get("/api/image-proxy", async (c) => {
  const raw = c.req.query("url");
  if (!raw) return c.json({ error: "url manquant" }, 400);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return c.json({ error: "url invalide" }, 400);
  }
  const jellyHost = new URL(config.jellyfinPublicUrl).host;
  const ok = u.host === jellyHost || PROXY_HOSTS.some((h) => u.host === h || u.host.endsWith("." + h));
  if (!ok || !/^https?:$/.test(u.protocol)) return c.json({ error: "hôte non autorisé" }, 403);
  const res = await fetch(u, {
    headers: u.host === jellyHost ? { "X-Emby-Token": config.jellyfinApiKey } : {},
  });
  if (!res.ok) return c.json({ error: `amont ${res.status}` }, 502);
  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
      "Cache-Control": "max-age=300",
    },
  });
});

// Remplit depuis Fanart (premier candidat) les types d'image manquants.
app.post("/api/autofill", async (c) => {
  const body = await c.req
    .json<{ types?: string[]; lock?: boolean }>()
    .catch(() => ({}) as { types?: string[]; lock?: boolean });
  const types = (body.types ?? ["Primary", "Backdrop", "Logo", "Thumb"]).filter(
    (t): t is ImageType => IMAGE_TYPES.includes(t as ImageType),
  );
  try {
    return c.json(await autofill(types, body.lock ?? false));
  } catch (e) {
    return c.json({ error: String(e) }, 409);
  }
});

// Front statique (une page pour l'instant, pas de build)
app.get("/", async (c) => c.html(await Bun.file("web/index.html").text()));

// Planificateur optionnel : HEAL_INTERVAL_MIN=60 lance une guérison toutes les 60 min.
const intervalMin = Number(process.env.HEAL_INTERVAL_MIN ?? 0);
if (intervalMin > 0) {
  console.log(`Guérison automatique toutes les ${intervalMin} min`);
  setInterval(() => {
    heal()
      .then((r) => {
        if (r.healed.length) console.log(`Guérison : ${r.healed.length} poster(s) restauré(s)`);
      })
      .catch((e) => console.error("Guérison échouée:", String(e)));
  }, intervalMin * 60_000);
}

console.log(`posterarr en écoute sur http://localhost:${config.port}`);

export default {
  port: config.port,
  fetch: app.fetch,
  // Les sets ThePosterDB de longues séries peuvent être volumineux (>128 Mo par défaut).
  maxRequestBodySize: 512 * 1024 * 1024,
};
