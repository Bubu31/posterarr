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
| `POST /api/items/:id/lock` | Verrouille / déverrouille (`{locked, imageType?}`) sans changer le poster. |
| `POST /api/heal` | Passe de guérison : ré-applique les posters verrouillés disparus ou remplacés. |
| `GET /` | Front : grille + vue détail (candidats, appliquer, verrouiller). |

## Feuille de route

- [x] **Étape 1** — connexion Jellyfin, listing bibliothèque avec posters actuels.
- [x] **Étape 2** — clients sources (TMDB, Fanart.tv) via interface `PosterSource`, endpoint `/api/items/:id/candidates`, vue détail. TVDB câblé (dormant), AniList/ThePosterDB/MediUX à venir.
- [x] **Étape 3** — DB SQLite (`managed_image` + `history`, clé `provider_key` type `tmdb:149`), application d'un poster via API Jellyfin (→ écrit folder.jpg, vérifié sur le NAS), verrouillage par item. Vue détail : appliquer / verrouiller.
- [x] **Étape 4** — **passe de guérison** (`/api/heal` + planificateur `HEAL_INTERVAL_MIN`) : détecte poster disparu (tag absent) ou remplacé (tag ≠ tag stocké) et ré-applique depuis `source_url`. Idempotent. Validé en simulant la perte de poster d'un item verrouillé → restauré. Pas de mode auto sur les nouveaux médias (Jellyfin s'en charge — décision assumée).
- [ ] **Étape 5** — bouton « guérir » dans l'UI + upload custom (drag-drop).
- [ ] **Étape 6** — packaging Docker + stack Komodo, sous-domaine `posterarr.busolin.fr`.
