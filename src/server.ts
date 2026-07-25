import { Hono } from "hono";
import { config } from "./config.ts";
import {
  getCollectionMembers,
  getGroups,
  getItemProviders,
  getLibrary,
  getPrimaryTag,
  ping,
  providerKey,
  setTmdbId,
  uploadImageFromUrl,
} from "./jellyfin.ts";
import { activeSourceNames, getCandidates } from "./sources/index.ts";
import { searchTmdb } from "./sources/tmdb.ts";
import { addHistory, getManaged, setAppliedTag, setLock, upsertManaged } from "./db.ts";
import { applyBytesToItem } from "./applyPoster.ts";
import { applyPosterZip } from "./posterZip.ts";
import { heal } from "./healer.ts";

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
  const collections = await getGroups("Series");
  return c.json({ count: collections.length, collections });
});

// Candidats de posters pour un item : résout ses ProviderIds puis interroge les sources.
app.get("/api/items/:id/candidates", async (c) => {
  const providers = await getItemProviders(c.req.param("id"));
  const ref = {
    type: providers.type,
    tmdbId: providers.tmdbId,
    imdbId: providers.imdbId,
    tvdbId: providers.tvdbId,
  };
  const candidates = await getCandidates(ref);
  const key = providerKey(providers);
  return c.json({
    item: providers,
    managed: key ? getManaged(key) : null,
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
  const imageType = body.imageType ?? "Primary";
  const lock = body.lock ?? true;

  const providers = await getItemProviders(c.req.param("id"));
  const key = providerKey(providers);
  if (!key) return c.json({ error: "Item sans identifiant stable (TMDB/IMDb/TVDB)" }, 422);

  await uploadImageFromUrl(providers.id, imageType, body.url);

  const now = new Date().toISOString();
  upsertManaged(key, imageType, body.source, body.url, lock, now);
  // Mémorise le tag résultant pour détecter une dérive future (guérison).
  setAppliedTag(key, imageType, await getPrimaryTag(providers.id));
  addHistory(key, imageType, "apply", body.source, body.url, now);

  return c.json({ ok: true, managed: getManaged(key, imageType) });
});

// Upload d'un poster custom (multipart). Stocké localement (guérissable) + locké.
app.post("/api/items/:id/apply-file", async (c) => {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) return c.json({ error: "Fichier 'file' manquant" }, 400);
  const imageType = typeof form["imageType"] === "string" ? form["imageType"] : "Primary";

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

// Verrouille / déverrouille un item (sans changer le poster).
app.post("/api/items/:id/lock", async (c) => {
  const body = await c.req.json<{ locked: boolean; imageType?: string }>();
  const imageType = body.imageType ?? "Primary";
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

export default { port: config.port, fetch: app.fetch };
