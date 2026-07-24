// État persistant posterarr (SQLite natif Bun).
// La clé durable est le provider_key (ex. "tmdb:149"), pas le Jellyfin ItemId
// qui peut changer lors d'un upgrade Radarr/Sonarr. image_type prépare l'extension
// future aux autres images (Logo, Backdrop…) — pour l'instant on n'écrit que "Primary".

import { Database } from "bun:sqlite";

const db = new Database(process.env.DB_PATH ?? "posterarr.db");
db.run("PRAGMA journal_mode = WAL");

db.run(`
  CREATE TABLE IF NOT EXISTS managed_image (
    provider_key TEXT NOT NULL,
    image_type   TEXT NOT NULL DEFAULT 'Primary',
    source       TEXT NOT NULL,          -- 'tmdb' | 'fanart' | 'custom' | ...
    source_url   TEXT,                    -- URL d'origine (null pour un upload custom)
    locked       INTEGER NOT NULL DEFAULT 0,
    applied_at   TEXT NOT NULL,
    applied_tag  TEXT,                    -- tag Primary Jellyfin au moment de l'apply (détection de dérive)
    PRIMARY KEY (provider_key, image_type)
  )
`);

// Migration idempotente pour les bases créées avant applied_tag.
const cols = db.query("PRAGMA table_info(managed_image)").all() as Array<{ name: string }>;
if (!cols.some((c) => c.name === "applied_tag")) {
  db.run("ALTER TABLE managed_image ADD COLUMN applied_tag TEXT");
}

db.run(`
  CREATE TABLE IF NOT EXISTS history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_key TEXT NOT NULL,
    image_type   TEXT NOT NULL,
    action       TEXT NOT NULL,           -- 'apply' | 'lock' | 'unlock' | 'heal'
    source       TEXT,
    source_url   TEXT,
    at           TEXT NOT NULL
  )
`);

export interface ManagedImage {
  provider_key: string;
  image_type: string;
  source: string;
  source_url: string | null;
  locked: number;
  applied_at: string;
  applied_tag: string | null;
}

/** Items verrouillés — cible de la passe de guérison. */
export function listLocked(): ManagedImage[] {
  return db.query("SELECT * FROM managed_image WHERE locked = 1").all() as ManagedImage[];
}

export function setAppliedTag(providerKey: string, imageType: string, tag: string | null): void {
  db.run("UPDATE managed_image SET applied_tag = ? WHERE provider_key = ? AND image_type = ?", [
    tag,
    providerKey,
    imageType,
  ]);
}

export function getManaged(providerKey: string, imageType = "Primary"): ManagedImage | null {
  return db
    .query("SELECT * FROM managed_image WHERE provider_key = ? AND image_type = ?")
    .get(providerKey, imageType) as ManagedImage | null;
}

/** Tous les items gérés (pour la passe de guérison et l'affichage). */
export function listManaged(): ManagedImage[] {
  return db.query("SELECT * FROM managed_image").all() as ManagedImage[];
}

export function upsertManaged(
  providerKey: string,
  imageType: string,
  source: string,
  sourceUrl: string | null,
  locked: boolean,
  at: string,
): void {
  db.run(
    `INSERT INTO managed_image (provider_key, image_type, source, source_url, locked, applied_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_key, image_type) DO UPDATE SET
       source = excluded.source,
       source_url = excluded.source_url,
       locked = excluded.locked,
       applied_at = excluded.applied_at`,
    [providerKey, imageType, source, sourceUrl, locked ? 1 : 0, at],
  );
}

export function setLock(providerKey: string, imageType: string, locked: boolean): void {
  db.run("UPDATE managed_image SET locked = ? WHERE provider_key = ? AND image_type = ?", [
    locked ? 1 : 0,
    providerKey,
    imageType,
  ]);
}

export function addHistory(
  providerKey: string,
  imageType: string,
  action: string,
  source: string | null,
  sourceUrl: string | null,
  at: string,
): void {
  db.run(
    "INSERT INTO history (provider_key, image_type, action, source, source_url, at) VALUES (?, ?, ?, ?, ?, ?)",
    [providerKey, imageType, action, source, sourceUrl, at],
  );
}
