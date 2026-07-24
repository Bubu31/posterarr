import { Hono } from "hono";
import { config } from "./config.ts";
import {
  getItemProviders,
  getLibrary,
  getPrimaryTag,
  ping,
  providerKey,
  uploadImageFromUrl,
} from "./jellyfin.ts";
import { activeSourceNames, getCandidates } from "./sources/index.ts";
import { addHistory, getManaged, setAppliedTag, setLock, upsertManaged } from "./db.ts";
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
