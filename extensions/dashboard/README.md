# Cap : tableau de bord de recherche d'emploi

Cap est une page (artefact claude.ai) qui montre les données de career-ops sur téléphone et sur ordinateur : accueil, offres, candidatures, planning, messages Outlook, analytique et réglages. Elle lit une base de l'artefact que Claude remplit au début de chaque session career-ops, et elle lit Outlook en direct, en lecture seule, par le connecteur Microsoft 365.

La page n'écrit jamais dans le tracker. Un changement de statut ou une note saisis sur la page deviennent une **demande** (`requests/<id>`), que Claude applique à la session suivante par `set-status.mjs`, le seul chemin d'écriture du tracker.

- `export.mjs` : lit les données de career-ops et prépare l'instantané (`snapshot/*`). Lecture seule, n'écrit rien sur le disque.
- `apply-requests.mjs` : applique les demandes de la page par `set-status.mjs` et prépare les écritures de résultat.
- `page/` : la page publiée (HTML, CSS, scripts classiques).
- `test/` : les tests, sur des données fictives (`test/fixtures/root`).

Le slug de l'artefact n'est pas dans ce dépôt : il est dans la couche utilisateur, `{DATA_ROOT}/data/dashboard.json` (`{"slug": "…"}`).

## Synchronisation (au début de chaque session)

Claude fait les deux étapes dans cet ordre. Un seul `db_write` à la fois, et 2 secondes d'attente après chaque appel.

### 1. Appliquer les demandes de la page

1. Lire les demandes en attente :
   `db_query {slug, collection: "requests", where: [{field: "state", op: "==", value: "pending"}], orderBy: "created_at", limit: 1000}`
2. Enregistrer la réponse telle quelle (résumé, balise et une ligne JSON par document) dans un fichier temporaire, hors du dépôt.
3. Lancer :
   `node extensions/dashboard/apply-requests.mjs --in <fichier>`
   Le script prend les demandes dont `state` vaut exactement `"pending"`, dans l'ordre de `created_at` puis de l'id. Une demande de statut porte `from_status`, le statut que la page voyait : le script le passe à `set-status.mjs --expect-status`, qui refuse si la ligne a changé depuis. La date de l'événement (`--on`) est le jour de `created_at` à Paris.
4. Il affiche `{"ops": […], "batches": [[…], …], "results": […]}`. Envoyer chaque élément de `batches` dans un `db_write {slug, ops: <batch>}`, dans l'ordre, en attendant 2 secondes entre deux appels. Chaque op est un `merge` des seuls champs de résultat (`state`, `reason`, `applied_at`, `from_status_seen`) avec `ifVersion` : le corps de la demande reste intact, et la page affiche le refus sur la ligne.
5. Si un `db_write` est refusé pour une version (la demande a changé entre-temps), relire avec `db_query` et recommencer cette étape ; une demande déjà appliquée est idempotente côté tracker.

`--dry-run` vérifie sans rien écrire : les demandes valables sortent en `would_apply`, sans ops.

### 2. Envoyer l'instantané

1. Lire les documents actuels : `db_list {slug, collection: "snapshot", limit: 1000}` (suivre `nextCursor` s'il n'est pas vide et mettre toutes les pages dans le fichier). Enregistrer la réponse telle quelle dans un fichier temporaire ; pour une toute première synchronisation, un fichier vide.
2. Lancer :
   `node extensions/dashboard/export.mjs --sync-plan --current <fichier>`
3. Il affiche `{"batches": [[…], …]}`. Envoyer chaque lot dans un `db_write`, **dans l'ordre**, en attendant 2 secondes entre deux appels :
   - d'abord les nouvelles parties (`set` de documents neufs : leurs ids portent la génération, `snapshot/apps-g20261127T161200000Z-0`) ;
   - puis un lot qui bascule `snapshot/meta` (`set` avec `ifVersion`) et supprime les anciennes parties (`delete` avec `ifVersion`) ;
   - les suppressions en trop éventuelles suivent, après la bascule.

Si la synchronisation s'arrête en route, la génération précédente reste entière dans la base, et la page continue de l'afficher. Si la base ne contient qu'une `snapshot/meta` dont les parties manquent, la page l'indique (« Synchronisation incomplète — les données seront rétablies à la prochaine session ») : refaire l'étape 2.

`node extensions/dashboard/export.mjs` sans option affiche `{"docs": […]}` ; `--summary` donne la taille de chaque document.

## Publier la page

Depuis les fichiers, avec `publish_files` : chaque fichier de `extensions/dashboard/page/` avec pour `as` son chemin sous `page/` (`index.html`, `css/app.css`, `js/data.js`, `js/screens/accueil.js`, …).

- Première publication : titre « Cap », icône « chart », sans slug. Enregistrer le slug obtenu dans `{DATA_ROOT}/data/dashboard.json`.
- Republication : `get_artifact` pour la version en ligne, `list_files` pour garder les mêmes chemins, puis `publish_files` avec `slug`, `base_version` et les fichiers modifiés (mode `patch` par défaut ; `mode: "replace"` pour retirer un fichier disparu).

## Capacités déclarées

Avec `read_declaration` puis `declare_capabilities` (la déclaration est complète : ce qui n'y figure pas n'est plus déclaré) :

```json
{"db":{"rules":[{"path":"snapshot","read":"owner","write":"owner"},{"path":"requests","read":"owner","write":"owner"},{"path":"handled","read":"owner","write":"owner"},{"path":"settings","read":"owner","write":"owner"}]},
 "mcp":{"servers":[{"server":"Microsoft 365","tools":["outlook_email_search","outlook_calendar_search"]}]}}
```

Pas de `desktop` (inutilisé) ni de `user` (la page ne l'appelle pas). La page n'utilise que les deux outils de recherche Outlook : elle n'envoie, ne déplace et ne supprime aucun e-mail.

## Variables d'environnement

- En session normale, aucune : les deux scripts trouvent la racine des données comme le reste de career-ops (`path-resolver.mjs` : `CAREER_OPS_ROOT` ou `CAREER_OPS_DATA_DIR`, le marqueur `.career-ops-data`, sinon la racine par défaut ; `CAREER_OPS_TRACKER` et `CAREER_OPS_PROFILE` s'ils sont définis).
- `apply-requests.mjs` lance lui-même `set-status.mjs` avec `TZ=Europe/Paris`, pour que sa vérification « date dans le futur » compte en jours de Paris : rien à régler.
- `CAREER_OPS_TRUST_PROXY_EGRESS` n'est utile à aucun des deux scripts : ils ne font aucun appel réseau.
- Tests seulement : `CAREER_OPS_ROOT` pointe vers `extensions/dashboard/test/fixtures/root` (ou une copie temporaire). Ne jamais lancer `export.mjs` ou `apply-requests.mjs` d'essai sur les vraies données.

## Tests

`node --test 'extensions/dashboard/test/**/*.test.mjs'` (Playwright et Chromium pour les tests de page).
