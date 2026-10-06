# Plan de déploiement — Netlify + structure de dépôt pour HelpNaud.ai

## 1. Fichier unique ou découpage en plusieurs fichiers ?

**Recommandation : garder `helpnaud.html` comme fichier unique pour ce premier
déploiement Netlify.** Renommer simplement en `index.html` à la racine du dépôt.

Pourquoi ne pas découper maintenant :
- Vous migrez déjà deux choses à la fois sur le plan "stockage" (localStorage →
  Supabase) et "authentification" (gating local → Supabase Auth). Ajouter en même
  temps un découpage en fichiers `.js`/`.css` séparés est une **troisième migration**
  indépendante, avec son propre risque (erreurs d'ordre de chargement de script,
  variables globales qui ne se retrouvent plus, chemins relatifs à corriger partout).
- Le fichier actuel fonctionne comme un tout cohérent depuis longtemps (30 300 lignes,
  des dizaines de modules internes qui se référencent les uns les autres par variables
  globales `var`/`function` au même scope). Le découper correctement demanderait un
  vrai travail de modularisation (imports/exports ES modules, ou au minimum une
  convention de chargement par balises `<script>` ordonnées) — un projet à part,
  distinct de "brancher Supabase".
- Netlify héberge un fichier HTML unique exactement aussi bien qu'un projet à 50
  fichiers : il n'y a **aucun gain de déploiement** à découper maintenant.

Le découpage en fichiers séparés reste une bonne idée **plus tard**, une fois que le
branchement Supabase est stable et testé, et qu'on peut s'y consacrer sans empiler les
risques. Quand ce jour viendra, un découpage naturel serait : `index.html` (squelette +
balises), `styles.css`, et plusieurs fichiers JS par domaine (`app-financier.js`,
`fgh-colab.js`, `assistant-ia.js`, etc.) chargés dans l'ordre via `<script defer>`.

## 2. Où va la configuration Supabase (URL + clé anonyme) ?

Netlify héberge des fichiers statiques : **pas de build obligatoire**, mais Netlify
sait aussi exécuter une étape de build optionnelle si on lui en donne une. Trois
options, de la plus simple à la plus robuste :

### Option A — Config publique en clair dans un fichier séparé (la plus simple)
La clé **anonyme** (`anon key`) de Supabase est, par design, sans danger à exposer
côté client : toute la sécurité réelle repose sur les policies RLS définies dans
`supabase-schema.sql`, pas sur le secret de cette clé. On peut donc littéralement
committer :

```js
// config.js — non secret, committé dans le dépôt
window.HELPNAUD_SUPABASE_CONFIG = {
  url: "https://xxxxxxxx.supabase.co",
  anonKey: "eyJhbGciOi..."
};
```
et charger `config.js` avant le script Supabase dans `index.html` :
```html
<script src="config.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
```
**Avantage** : zéro étape de build, déploiement Netlify instantané (glisser-déposer le
dossier fonctionnerait même). **Inconvénient** : changer d'environnement (ex. un projet
Supabase de test vs. production) veut dire modifier et committer `config.js` à chaque
fois.

### Option B — Variables d'environnement Netlify + petite étape de build (recommandée)
Netlify permet de définir des variables d'environnement dans l'interface (Site
settings → Environment variables) : `SUPABASE_URL`, `SUPABASE_ANON_KEY`. On ajoute une
commande de build minimale qui génère `config.js` à partir de ces variables au moment
du déploiement, sans toucher au reste du site :

```toml
# netlify.toml (voir §4) — la commande de build :
[build]
  command = "node -e \"require('fs').writeFileSync('config.js', 'window.HELPNAUD_SUPABASE_CONFIG = ' + JSON.stringify({url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY}) + ';')\""
  publish = "."
```
**Avantage** : les clés ne sont jamais committées dans Git ; changer d'environnement
(preview/production) se fait entièrement depuis l'interface Netlify, sans toucher au
code. **Inconvénient** : une (très petite) étape de build à maintenir — mais elle ne
touche à rien d'autre que la génération de `config.js`, donc risque quasi nul sur le
reste du site.

### Option C — Variables d'environnement injectées par un plugin Netlify dédié
Il existe des plugins Netlify (`netlify-plugin-inline-source`, ou un plugin maison) qui
font la même injection que l'option B de façon plus "officielle". Pas nécessaire pour
un site de cette taille — l'option B fait exactement la même chose avec une ligne de
commande, sans dépendance supplémentaire.

**Recommandation finale : Option B.** Elle garde le dépôt propre (aucun secret, même
non sensible, committé), tout en restant une étape de build triviale à auditer en une
ligne. L'anon key reste par nature visible dans le JS livré au navigateur une fois le
site chargé (c'est voulu et sans danger), mais elle n'apparaît jamais dans l'historique
Git ni dans le code source du dépôt.

## 3. Structure de dépôt recommandée

```
/                              racine du dépôt Git
├── netlify.toml                configuration de build/déploiement Netlify
├── index.html                  anciennement helpnaud.html, renommé (fichier unique pour l'instant)
├── config.js                   généré au build (Option B) — NE PAS committer si Option B ;
│                                committer tel quel seulement si Option A est retenue
├── .gitignore                  doit exclure config.js si Option B (voir plus bas)
└── supabase/
    ├── schema.sql               copie de référence de supabase-schema.sql (source de vérité
    │                            = ce qui a réellement été exécuté dans l'éditeur SQL Supabase)
    ├── migration-plan.md        copie de référence de supabase-auth-migration.md
    └── migrate-team.js          script de migration ponctuel (§5 du plan d'authentification) —
                                 ne JAMAIS déployer ce fichier sur Netlify (voir netlify.toml,
                                 il n'est pas dans "publish")
```

Point important : `supabase/` est un dossier de **documentation et d'outillage**, pas
un dossier servi par Netlify (le `publish = "."` dans `netlify.toml` sert tout le
contenu de la racine, mais `supabase/migrate-team.js` ne doit jamais contenir la clé
`service_role` en dur — elle est lue depuis une variable d'environnement locale au
moment de l'exécution ponctuelle du script, jamais depuis Netlify).

### `.gitignore` recommandé si Option B est retenue
```
config.js
node_modules/
.env
.env.local
```

## 4. `netlify.toml`

```toml
[build]
  # Option B (recommandée) : génère config.js à partir des variables d'environnement
  # Netlify (Site settings > Environment variables : SUPABASE_URL, SUPABASE_ANON_KEY).
  # Si vous préférez l'Option A (config.js committé en clair), remplacez cette ligne
  # par: command = "true"   (ou supprimez complètement la clé [build], un site 100%
  # statique sans aucune étape de build fonctionne aussi très bien).
  command = "node -e \"require('fs').writeFileSync('config.js', 'window.HELPNAUD_SUPABASE_CONFIG = ' + JSON.stringify({url: process.env.SUPABASE_URL, anonKey: process.env.SUPABASE_ANON_KEY}) + ';')\""
  publish = "."

[build.environment]
  # Fixe la version de Node utilisée pour exécuter la commande de build ci-dessus.
  NODE_VERSION = "20"

# En-têtes de sécurité de base pour un site statique exposé publiquement.
[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"

# index.html est un fichier unique sans routes côté client à gérer (pas de React
# Router/Vue Router) — aucune règle de redirection SPA n'est nécessaire pour l'instant.
# Si l'app évolue vers des URLs propres (ex. /dossier/123), ajouter alors :
# [[redirects]]
#   from = "/*"
#   to = "/index.html"
#   status = 200
```

## 5. Étapes de déploiement, dans l'ordre

1. Créer le dépôt Git (GitHub/GitLab) avec la structure ci-dessus ; copier
   `helpnaud.html` vers `index.html` à la racine (aucune modification de contenu à ce
   stade).
2. Créer le site sur Netlify, connecté à ce dépôt.
3. Une fois le projet Supabase créé par vous, renseigner `SUPABASE_URL` et
   `SUPABASE_ANON_KEY` dans Netlify (Site settings → Environment variables) — jamais la
   clé `service_role`, qui n'a aucune raison d'exister sur Netlify.
4. Déclencher un déploiement : Netlify exécute la commande de build, génère
   `config.js`, publie `index.html` + `config.js` tels quels (aucune transformation du
   HTML lui-même).
5. Exécuter `supabase-schema.sql` dans l'éditeur SQL du projet Supabase (une fois).
6. Exécuter le script de migration ponctuel (`supabase/migrate-team.js`, en local, avec
   la clé `service_role` en variable d'environnement locale — jamais sur Netlify) pour
   créer les comptes `auth.users` + lignes `team_members` de l'équipe existante.
7. Ajouter dans `index.html` l'appel `supabase.createClient(window.HELPNAUD_SUPABASE_CONFIG.url, window.HELPNAUD_SUPABASE_CONFIG.anonKey)` et commencer à brancher les écrans
   (connexion membre/ADMINISTRATEUR en premier, voir `supabase-auth-migration.md`) à la
   place des fonctions `loadFghlabState()`/`persistFghlabState()` actuelles — ce
   branchement fonctionnel est un travail ultérieur, distinct de ce plan
   d'infrastructure.
