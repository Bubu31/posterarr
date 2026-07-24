// Config lue depuis l'environnement. Pas de valeurs par défaut pour les secrets :
// on veut un échec explicite au démarrage si Jellyfin n'est pas configuré.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

const jellyfinUrl = required("JELLYFIN_URL").replace(/\/+$/, "");

export const config = {
  // URL utilisée par le backend pour l'API Jellyfin (en prod : interne, ex. http://jellyfin:8096)
  jellyfinUrl,
  // URL publique servant à construire les liens d'images affichés dans le navigateur.
  // Par défaut = jellyfinUrl (dev). En prod, mettre JELLYFIN_PUBLIC_URL=https://jellyfin.busolin.fr
  jellyfinPublicUrl: (process.env.JELLYFIN_PUBLIC_URL ?? jellyfinUrl).replace(/\/+$/, ""),
  jellyfinApiKey: required("JELLYFIN_API_KEY"),
  port: Number(process.env.PORT ?? 3939),
  // Sources : clés optionnelles — une source sans clé se désactive d'elle-même.
  tmdbApiKey: process.env.TMDB_API_KEY ?? "",
  fanartApiKey: process.env.FANART_API_KEY ?? "",
  tvdbApiKey: process.env.TVDB_API_KEY ?? "",
};
