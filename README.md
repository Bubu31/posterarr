# posterarr

Gestion et **verrouillage** des posters pour Jellyfin — pensé au niveau de Sonarr/Radarr.
Alternative maison à posterpilot, centrée sur le contrôle : tu choisis un poster, tu le
**verrouilles**, et l'automatisation ne le touche plus jamais.

## Objectif

- Sources multiples de posters (TMDB, Fanart.tv, ThePosterDB — phase 2).
- Choix manuel avec preview des candidats, par item et par bibliothèque.
- **Verrouillage** par item : un poster locké n'est jamais écrasé par le mode auto.
- Mode auto « fire and forget » : nouveau média détecté → meilleur poster appliqué aux items non lockés.
- Cible : **Jellyfin uniquement** (pas d'abstraction multi-serveur pour l'instant).

## Stack

- **Bun + Hono** — API et service HTTP.
- **SQLite** (à venir, étape verrouillage) — état persistant : poster courant, source, lock, historique.
- Front : page statique vanilla pour le squelette ; **React + Vite** dès le sélecteur de candidats.
- Déploiement : une image Docker, stack Komodo comme le reste de l'infra (repo `Bubu31/posterarr`).

## Développement

```bash
bun install
cp .env.example .env   # renseigne JELLYFIN_URL et JELLYFIN_API_KEY
bun dev                # http://localhost:3939
```

## API (état actuel)

| Route | Rôle |
|---|---|
| `GET /api/health` | Vérifie la connexion Jellyfin (nom serveur + version). |
| `GET /api/library` | Liste films / séries / collections avec l'état du poster actuel. |
| `GET /api/items/:id/candidates` | Posters candidats (toutes sources) + état géré/verrouillé de l'item. |
| `POST /api/items/:id/apply` | Applique un poster (`{url, source, imageType?, lock?}`) → push API Jellyfin + enregistre. Locke par défaut. |
| `POST /api/items/:id/apply-file` | Upload d'un poster custom (multipart `file`) → stocké localement, poussé à Jellyfin, locké, guérissable. |
| `POST /api/items/:id/lock` | Verrouille / déverrouille (`{locked, imageType?}`) sans changer le poster. |
| `GET /api/tmdb/search` | Recherche TMDB (`?type=&query=&year=`) pour identifier un item non matché par Jellyfin. |
| `POST /api/items/:id/set-tmdb` | Associe un TMDB id (`{tmdbId}`) → l'écrit dans Jellyfin + refresh métadonnées (corrige le titre). |
| `POST /api/heal` | Passe de guérison : ré-applique les posters verrouillés disparus ou remplacés. |
| `GET /api/collections` | Collections (BoxSet) avec leurs films membres, pour la vue liste. |
| `POST /api/collections/:id/apply-zip` | Applique un set ThePosterDB (zip) : poster de collection + posters des films, matchés par année. |
| `GET /` | Front : grille + vue détail (candidats, appliquer, verrouiller). |

## Feuille de route

- [x] **Étape 1** — connexion Jellyfin, listing bibliothèque avec posters actuels.
- [x] **Étape 2** — clients sources (TMDB, Fanart.tv) via interface `PosterSource`, endpoint `/api/items/:id/candidates`, vue détail. TVDB câblé (dormant), AniList/ThePosterDB/MediUX à venir.
- [x] **Étape 3** — DB SQLite (`managed_image` + `history`, clé `provider_key` type `tmdb:149`), application d'un poster via API Jellyfin (→ écrit folder.jpg, vérifié sur le NAS), verrouillage par item. Vue détail : appliquer / verrouiller.
- [x] **Étape 4** — **passe de guérison** (`/api/heal` + planificateur `HEAL_INTERVAL_MIN`) : détecte poster disparu (tag absent) ou remplacé (tag ≠ tag stocké) et ré-applique depuis `source_url`. Idempotent. Validé en simulant la perte de poster d'un item verrouillé → restauré. Pas de mode auto sur les nouveaux médias (Jellyfin s'en charge — décision assumée).
- [x] **Étape 5a** — bouton « Guérir » dans l'UI (déclenche `/api/heal`, affiche le rapport).
- [x] **Étape 5c** — identification TMDB : pour les items que Jellyfin n'a pas matchés (pas de provider id → ni candidats ni guérison), recherche TMDB par titre/année, choix manuel, écriture de l'id dans Jellyfin + refresh (corrige aussi le titre). Sur cette bibliothèque : 6 items concernés sur 1873.
- [x] **Étape 5b** — upload custom (drag-drop / clic) : octets stockés localement (`<data>/custom/`, dans le volume persistant), poster locké, et **guérissable** (la passe de guérison relit le fichier local et le ré-applique). Endpoint `POST /api/items/:id/apply-file`.
- [x] **Étape 6** — déploiement : Dockerfile (Bun alpine) + `compose.yaml`, repo `Bubu31/posterarr`, stack Komodo (build depuis le repo), DNS `posterarr.busolin.fr` (OVH), guérison auto toutes les 6 h. En ligne : https://posterarr.busolin.fr

## Déploiement (infra Komodo)

- Stack Komodo `posterarr` sur le Media Server, build depuis ce repo (**public** — Komodo clone sans auth).
- Env du stack (secrets, non committés) : `JELLYFIN_URL=http://jellyfin:8096` (interne), `JELLYFIN_PUBLIC_URL=https://jellyfin.busolin.fr`, `JELLYFIN_API_KEY`, `TMDB_API_KEY`, `FANART_API_KEY`, `TVDB_API_KEY`, `HEAL_INTERVAL_MIN=360`, `POSTERARR_TAG` (= commit buildé, **à bumper à chaque deploy** pour que le tag image suive).
- DB persistée sur l'hôte : `/home/bubu/posterarr/data`.
- ⚠️ `gh repo create --public` a créé le repo **privé** par erreur → Komodo ne pouvait pas cloner. Corrigé via `gh repo edit --visibility public`.
