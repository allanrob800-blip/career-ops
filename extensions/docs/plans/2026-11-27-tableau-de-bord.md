# Tableau de bord « Cap » : plan de mise en œuvre

> **Pour les agents :** sous-compétence REQUISE : utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes utilisent la syntaxe à cases à cocher (`- [ ]`) pour le suivi.

**Objectif :** une page privée claude.ai (PC et iPhone) qui affiche le suivi career-ops et les messages et rendez-vous Outlook en direct, et qui permet de demander des changements de statut, appliqués ensuite par `set-status.mjs`.

**Architecture :**
- Un exportateur Node en lecture seule (`extensions/dashboard/export.mjs`) transforme la couche utilisateur en documents d'« instantané », chacun sous 60 Ko.
- Claude les écrit dans la base de l'artifact (`db_write`).
- La page, en HTML/CSS/JS sans étape de build et publiée depuis des fichiers, lit ces documents, lit Outlook via la capacité `mcp`, et écrit des demandes dans `requests/`.
- `apply-requests.mjs` applique ces demandes avec `set-status.mjs`.

**Pourquoi pas le type d'artifact « Data » :** le serveur d'artifacts le recommande pour les tableaux de bord. Il est écarté parce que sa page est montée dans le document du type : pas de style sur `body`/`html`, pas de barre d'onglets plein écran avec zones sûres iPhone, pas de capacité `desktop`. Or la spécification demande une application plein écran façon SaaS. C'est un choix de Claude.

**Technologies :** Node ≥ 18 (ESM, `node:test`), modules career-ops existants (`path-resolver.mjs`, `tracker-parse.mjs`, `stats.mjs`, `followup-cadence.mjs`, `lib/posting-close.mjs`), artifact claude.ai (contrat runtime 0.2.99 : `db`, `user`, `mcp`, `desktop`), la bibliothèque `playwright` (déjà installée, sans `@playwright/test`) pilotée par `node:test` pour les tests de page.

**Spécification :** `extensions/docs/specs/2026-11-27-tableau-de-bord-design.md` (à lire en entier avant toute tâche).

## Contraintes globales

- Tout fichier créé vit sous `extensions/`. Aucun fichier système career-ops n'est modifié (approche A).
- Aucune donnée personnelle dans le dépôt public : fixtures fictives uniquement, ni l'adresse e-mail, ni le nom du candidat, ni le slug de l'artifact.
- Chemins de la couche utilisateur résolus par `getCareerOpsRoot()` et `resolveTrackerPath()` de `path-resolver.mjs`, jamais par `__dirname`.
- Statuts : exactement les libellés de `templates/states.yml` (`Evaluated`, `Speculative`, `Applied`, `Responded`, `Assessment`, `Interview`, `Offer`, `Hired`, `Rejected`, `Discarded`, `SKIP`).
- Un document de la base ne dépasse pas **60 000 octets** de JSON (la limite d'un appel `db_write` est de 64 Ko).
- Semaine = semaine ISO, du lundi au dimanche, fuseau `Europe/Paris`.
- Page :
  - toute valeur venant de la base, d'Outlook ou d'un fichier s'insère par `textContent`, ou est échappée (`& < > " '`) avant d'entrer dans une chaîne HTML ou SVG ;
  - un lien n'est rendu que si l'URL commence par `https://` ;
  - pas d'attribut `on…=` ;
  - chaque `claude.use(...)` peut renvoyer `null` : la page doit rester utilisable sans lui.
- Page : lisible à 360 px, 430 px (iPhone 15 Pro Max), 720 px et 1440 px, sans défilement horizontal. `viewport-fit=cover` uniquement avec un remplissage `env(safe-area-inset-*)`. Cibles tactiles ≥ 44 px, champs en 16 px.
- Page : thème clair, sombre, et `data-theme` absent : les trois doivent être lisibles. Le mode sombre est donc requis par la plateforme, même si la spécification le laissait au constructeur. Respect de `prefers-reduced-motion`.
- Interface entièrement en français. Nom provisoire : « Cap ». Aucun nom, logo ni texte repris de HALO ou d'Andromis.
- La page n'envoie jamais d'e-mail et ne déclare que les outils Outlook de lecture `outlook_email_search` et `outlook_calendar_search`, sur le serveur « Microsoft 365 ».

## Points de vigilance pour la revue

1. **Tracker absent ou vide** (installation neuve) : l'export produit un instantané valide avec des listes vides, et la page affiche des états vides explicites, sans erreur. Testé en tâche 2 et en tâche 7.
2. **Contenu hostile** dans un nom d'entreprise, un objet d'e-mail ou une URL (`<img src=x onerror=…>`, `javascript:alert(1)`) : affiché comme du texte, sans lien et sans exécution. Testé en tâche 7.
3. **Outlook indisponible** (`mcp` vaut `null`, consentement refusé, ou outil en erreur) : les écrans Messages et Planning affichent un état clair avec la raison, et le reste fonctionne. Testé en tâche 8.
4. **Synchronisation à moitié écrite** (une partie des documents d'une nouvelle génération seulement) : la page garde l'ancienne génération complète jusqu'à ce que toutes les parties de la nouvelle soient présentes. Testé en tâche 6.
5. **Demande périmée ou invalide** (statut inconnu, ligne disparue, statut déjà changé) : rejetée avec la raison renvoyée par `set-status.mjs`, sans rien écrire, et affichée dans la page. Testé en tâche 4.

---

### Tâche 1 : rattacher un texte à une entreprise (code commun Node et navigateur)

**Fichiers :**
- Créer : `extensions/dashboard/page/js/match.js` (script classique, qui expose `globalThis.CapMatch`)
- Test : `extensions/dashboard/test/match.test.mjs` (charge le fichier dans un contexte `node:vm`)

**Interfaces :**
- Produit, sur `globalThis.CapMatch` :
  - `normalizeCompany(name: string): string` : minuscules, sans accents (NFD sans diacritiques), suffixes juridiques retirés en fin de nom (`sas`, `sasu`, `sa`, `sarl`, `inc`, `ltd`, `llc`, `gmbh`, `bv`, `ag`, `plc`, `corp`, `corporation`, `group`, `groupe`), ponctuation remplacée par des espaces, espaces compactés.
  - `domainsFromUrl(url: string): string[]` : le domaine enregistrable de l'URL (`jobs.acme.fr` → `acme.fr`), ou `[]` pour un hébergeur d'ATS (`greenhouse.io`, `lever.co`, `ashbyhq.com`, `workable.com`, `smartrecruiters.com`, `myworkdayjobs.com`, `welcometothejungle.com`, `teamtailor.com`, `recruitee.com`, `personio.de`, `personio.com`, `linkedin.com`, `indeed.com`, `indeed.fr`) ou pour une URL invalide.
  - `matchCompany(fields: {sender?: string, senderName?: string, subject?: string, text?: string}, companies: {name: string, norm: string, domains: string[]}[]): string | null` : renvoie le `name` de la première entreprise dont un domaine correspond à la fin du domaine de l'expéditeur, sinon dont le `norm` apparaît comme mot entier dans `normalizeCompany` de chaque champ. Les `norm` de moins de 3 caractères sont ignorés.
  - `isJobRelated(fields): boolean` : vrai si l'objet ou le texte, normalisés, contiennent l'un de `candidature`, `entretien`, `recrutement`, `recruteur`, `poste`, `offre d'emploi`, `interview`, `application`, `hiring`, `recruiter`, `assessment`, `test technique`.
  - `isInterviewEvent(fields, companies): boolean` : `matchCompany` non nul, ou titre contenant `entretien`, `interview`, `call`, `visio`, `echange`, `rencontre` (après normalisation).

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
test('normalizeCompany strips accents, case and legal suffixes', () => {
  assert.equal(M.normalizeCompany('Société Générale SA'), 'societe generale');
  assert.equal(M.normalizeCompany('ACME, Inc.'), 'acme');
});
test('domainsFromUrl drops ATS hosts', () => {
  assert.deepEqual(M.domainsFromUrl('https://jobs.acme.fr/x'), ['acme.fr']);
  assert.deepEqual(M.domainsFromUrl('https://boards.greenhouse.io/acme/1'), []);
  assert.deepEqual(M.domainsFromUrl('not a url'), []);
});
test('matchCompany prefers sender domain, then whole-word name', () => {
  const cs = [{ name: 'Acme', norm: 'acme', domains: ['acme.fr'] }, { name: 'Bo', norm: 'bo', domains: [] }];
  assert.equal(M.matchCompany({ sender: 'rh@mail.acme.fr' }, cs), 'Acme');
  assert.equal(M.matchCompany({ subject: 'Votre candidature chez ACME SAS' }, cs), 'Acme');
  assert.equal(M.matchCompany({ subject: 'Acmeville news' }, cs), null);
  assert.equal(M.matchCompany({ subject: 'bo bo' }, cs), null); // norm < 3 ignoré
});
test('isJobRelated and isInterviewEvent', () => {
  assert.equal(M.isJobRelated({ subject: 'Suite à votre candidature' }), true);
  assert.equal(M.isJobRelated({ subject: 'Black Friday -50 %' }), false);
  assert.equal(M.isInterviewEvent({ subject: 'Échange avec Marie' }, []), true);
});
```

- [ ] **Étape 2 : lancer et vérifier l'échec**

Commande : `node --test extensions/dashboard/test/match.test.mjs`
Attendu : ÉCHEC (fichier introuvable).

- [ ] **Étape 3 : implémenter `match.js`**

Une IIFE qui affecte `globalThis.CapMatch`. Aucune API Node ni DOM.

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): shared company matching for Outlook items`

---

### Tâche 2 : construire l'instantané (fonctions pures)

**Fichiers :**
- Créer : `extensions/dashboard/lib/report-summary.mjs`, `extensions/dashboard/lib/snapshot.mjs`
- Créer les fixtures, toutes fictives : `extensions/dashboard/test/fixtures/root/data/applications.md` (8 lignes couvrant `Evaluated`, `Applied` ×3, `Responded`, `Interview`, `Rejected`, `SKIP` ; l'une a pour entreprise `<img src=x onerror=alert(1)>`), `data/status-log.tsv`, `data/follow-ups.md`, `data/pipeline.md` (3 entrées `- [ ]`, dont une avec `| Société | Rôle`), `reports/001-acme-pm.md` (en-têtes `**Score:**`, `**URL:**`, `**Archetype:**`, `**Legitimacy:**`, sections `## B) Match with CV`), `config/profile.yml` (`candidate.full_name: "Camille Test"`)
- Test : `extensions/dashboard/test/snapshot.test.mjs`, `extensions/dashboard/test/report-summary.test.mjs`

**Interfaces :**
- Consomme :
  - `computeTrackerStats(content)` et `trackerStatusByNum(content)` de `stats.mjs` ;
  - `analyzeFromContent(trackerContent, followupsContent, {statusLogContent})` de `followup-cadence.mjs` (lire ses champs `entries[].num/company/nextFollowupDate/urgency`) ;
  - `resolveColumns(lines)`, `parseTrackerRow(line, colmap)` et `extractTrackerReportNumbers(reportCell, notesCell)` de `tracker-parse.mjs` ;
  - `closeDatesByUrl(text)` et `closeDateForUrl(index, url)` de `lib/posting-close.mjs` ;
  - `CapMatch.normalizeCompany` et `CapMatch.domainsFromUrl` (tâche 1, chargé avec `node:vm` dans `snapshot.mjs`, via un petit chargeur `loadMatch()` exporté).
- Produit :
  - `summarizeReport(markdown: string, num: number): {num, score: number|null, archetype: string|null, legitimacy: string|null, url: string|null, strengths: string[], gaps: string[]}`. Au plus 3 points forts et 3 lacunes, chacun tronqué à 160 caractères. Ils viennent des puces de la section dont le titre contient `Match` : lignes avec ✅ ou « strength » pour les points forts, ⚠️/❌ ou « gap » pour les lacunes. `url` vaut `null` si elle ne commence pas par `https://`.
  - `buildSnapshot(input: {trackerContent: string, statusLogContent: string, followupsContent: string, pipelineContent: string, reports: {num: number, content: string}[], profileYaml: string, now: Date}): Snapshot`

```ts
type Snapshot = {
  schema: 1, generation: string /* now ISO */, generated_at: string,
  profile: { first_name: string|null },          // 1er mot de candidate.full_name
  apps: { num, date, company, role, score: number|null, status: string /* libellé canonique */,
          url: string|null, report_num: number|null, applied_on: string|null /* YYYY-MM-DD */,
          last_change: string|null, next_followup: string|null, followup_urgency: string|null,
          closes_at: string|null }[],
  offers: { url: string, company: string|null, role: string|null }[],   // pipeline.md non cochées
  stats: ReturnType<computeTrackerStats>,
  timeline: { date: string, evaluated: number, applied: number }[],    // 180 derniers jours, jours vides inclus
  followups_due: { num, company, role, due: string, urgency: string }[], // urgency ∈ overdue|urgent
  reports: ReturnType<summarizeReport>[],
  companies: { name: string, norm: string, domains: string[] }[]       // une par entreprise du tracker
}
```

  `applied_on` est lu dans `status-log.tsv` (premier passage `to = Applied`) ; à défaut, c'est la colonne date de la ligne si son statut est `Applied` ou plus avancé.

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
test('buildSnapshot on fixtures', () => {
  const s = buildSnapshot(loadFixtureInput(new Date('2026-11-27T10:00:00Z')));
  assert.equal(s.schema, 1);
  assert.equal(s.apps.length, 8);
  assert.equal(s.profile.first_name, 'Camille');
  assert.ok(s.apps.every(a => STATES.includes(a.status)));
  assert.equal(s.offers.length, 3);
  assert.equal(s.timeline.length, 180);
  assert.ok(s.companies.find(c => c.norm === 'acme'));
  assert.equal(s.apps.find(a => a.num === 3).applied_on, '2026-11-24'); // depuis status-log
});
test('buildSnapshot on empty inputs', () => {
  const s = buildSnapshot({ trackerContent: '', statusLogContent: '', followupsContent: '',
    pipelineContent: '', reports: [], profileYaml: '', now: new Date('2026-11-27T10:00:00Z') });
  assert.deepEqual([s.apps, s.offers, s.followups_due, s.reports], [[], [], [], []]);
  assert.equal(s.profile.first_name, null);
});
test('summarizeReport', () => {
  const r = summarizeReport(readFixture('reports/001-acme-pm.md'), 1);
  assert.equal(r.score, 4.2); assert.equal(r.legitimacy, 'High Confidence');
  assert.ok(r.strengths.length <= 3 && r.gaps.length <= 3);
});
```

- [ ] **Étape 2 : lancer et vérifier l'échec**

Commande : `node --test extensions/dashboard/test/`
Attendu : ÉCHEC.

- [ ] **Étape 3 : implémenter `report-summary.mjs` puis `snapshot.mjs`**

`snapshot.mjs` n'effectue aucune lecture de fichier et lit `now` uniquement dans son entrée.

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): pure snapshot builder and report summaries`

---

### Tâche 3 : découper en documents et exporter en ligne de commande

**Fichiers :**
- Créer : `extensions/dashboard/lib/chunk.mjs`, `extensions/dashboard/export.mjs`
- Test : `extensions/dashboard/test/chunk.test.mjs`, `extensions/dashboard/test/export.test.mjs`

**Interfaces :**
- Consomme : `buildSnapshot` (tâche 2) ; `getCareerOpsRoot()` et `resolveTrackerPath(root)` de `path-resolver.mjs` ; `getProfilePath(root)`.
- Produit :
  - `toDocs(snapshot: Snapshot, maxBytes = 60000): {path: string, data: object}[]`
    - `snapshot/meta` contient `{schema, generation, generated_at, profile, stats, timeline, followups_due, companies, parts: string[]}` ;
    - les tableaux `apps`, `offers` et `reports` sont découpés en `snapshot/apps-0…n`, `snapshot/offers-0…n` et `snapshot/reports-0…n`, chacun de la forme `{generation, items}` ;
    - `parts` liste ces chemins dans l'ordre ;
    - lève une erreur si un seul élément dépasse `maxBytes`.
  - CLI `node extensions/dashboard/export.mjs` : imprime `{"docs":[…]}` sur la sortie standard. Avec `--summary`, imprime une ligne par document (chemin et taille). N'écrit jamais rien sur disque.

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
test('toDocs keeps every doc under the limit and lists parts', () => {
  const big = fakeSnapshot({ apps: 900 });            // ~200 Ko
  const docs = toDocs(big);
  assert.ok(docs.every(d => Buffer.byteLength(JSON.stringify(d.data)) <= 60000));
  const meta = docs.find(d => d.path === 'snapshot/meta').data;
  assert.deepEqual(meta.parts, docs.filter(d => d.path !== 'snapshot/meta').map(d => d.path));
  assert.ok(docs.every(d => d.path === 'snapshot/meta' || d.data.generation === big.generation));
});
test('export CLI runs read-only against fixture root', () => {
  const before = hashTree(FIXTURE_ROOT);
  const out = execFileSync('node', ['extensions/dashboard/export.mjs'],
    { env: { ...process.env, CAREER_OPS_ROOT: FIXTURE_ROOT } });
  assert.ok(JSON.parse(out).docs.length >= 4);
  assert.equal(hashTree(FIXTURE_ROOT), before);
});
```

- [ ] **Étape 2 : lancer et vérifier l'échec**

- [ ] **Étape 3 : implémenter `chunk.mjs` et `export.mjs`**

Les fichiers absents sont lus comme `''`. Les rapports sont lus dans `{root}/reports/NNN-*.md`, uniquement pour les numéros référencés par le tracker.

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): chunked read-only snapshot export CLI`

---

### Tâche 4 : appliquer les demandes de la page

**Fichiers :**
- Créer : `extensions/dashboard/apply-requests.mjs`
- Test : `extensions/dashboard/test/apply-requests.test.mjs`. Il travaille sur une **copie temporaire** de la racine fixture (`fs.cpSync` vers `os.tmpdir()`), avec `CAREER_OPS_ROOT` qui pointe dessus.

**Interfaces :**
- Entrée (`--in <fichier.json>`) : `[{id: string, data: {type: "status"|"note", ref: number, to_status?: string, note?: string, created_at: string, state: "pending"}}]`. C'est la forme que donne `db_list` sur `requests`.
- Sortie, JSON sur la sortie standard : `[{id, state: "applied"|"rejected", reason: string|null, applied_at: string|null}]`. C'est ce que Claude réécrit dans `requests/{id}`.
- Comportement :
  - ignore les demandes dont `state ≠ "pending"` ;
  - rejette sans appeler le script si `to_status` n'est pas un libellé canonique, si `ref` n'est pas un entier positif, ou si `note` dépasse 500 caractères ou contient des caractères de contrôle ;
  - sinon, appelle `execFile(process.execPath, ['set-status.mjs', String(ref), to_status, '--on', created_at.slice(0,10), '--json', ...(note ? ['--note', note] : [])], {cwd: PROJECT_ROOT})`. Jamais via un shell.
  - pour une demande `note` seule, utilise le statut actuel de la ligne (lu par `trackerStatusByNum`) comme `to_status`, avec `--note` ;
  - `reason` reprend le message d'erreur de `set-status.mjs` en cas de code de sortie non nul ;
  - `--dry-run` transmet `--dry-run` au script.

- [ ] **Étape 1 : écrire les tests qui échouent**

```js
test('valid status request is applied with the request date', () => {
  const res = run([{ id: 'r1', data: { type: 'status', ref: 3, to_status: 'Interview',
    created_at: '2026-11-26T18:00:00Z', state: 'pending' } }]);
  assert.equal(res[0].state, 'applied');
  assert.match(readTracker(), /\|\s*3\s*\|.*\|\s*Interview\s*\|/);
  assert.match(readStatusLog(), /^3\t2026-11-26\t/m);
});
test('invalid requests are rejected without writing', () => {
  const before = readTracker();
  const res = run([
    { id: 'a', data: { type: 'status', ref: 3, to_status: 'Hacked', created_at: '2026-11-26T00:00:00Z', state: 'pending' } },
    { id: 'b', data: { type: 'status', ref: 999, to_status: 'Applied', created_at: '2026-11-26T00:00:00Z', state: 'pending' } },
    { id: 'c', data: { type: 'note', ref: 3, note: 'x\u0007', created_at: '2026-11-26T00:00:00Z', state: 'pending' } }]);
  assert.deepEqual(res.map(r => r.state), ['rejected', 'rejected', 'rejected']);
  assert.ok(res.every(r => r.reason));
  assert.equal(readTracker(), before);
});
```

- [ ] **Étape 2 : lancer et vérifier l'échec**

- [ ] **Étape 3 : implémenter `apply-requests.mjs`**

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): apply page change requests through set-status`

---

### Tâche 5 : banc d'essai de la page (harnais Playwright)

**Fichiers :**
- Créer : `extensions/dashboard/test/page/harness.mjs` et `extensions/dashboard/test/page/fake-claude.js`
- Créer : `extensions/dashboard/test/page/smoke.test.mjs`
- Créer : `extensions/dashboard/page/index.html` (squelette : coquille, menu, 7 conteneurs d'écran vides), `page/css/app.css` (jetons de couleur et mise en page de base), `page/js/app.js` (démarrage)

**Interfaces :**
- `fake-claude.js` installe `window.claude = { use(name) }`, piloté par `window.__fake = { db: {docs: {path: data}}, mcp: {mode: 'ok'|'null'|'error', emails: [...], events: [...]}, user: {id: 'u1'} }`.
  - Le faux `db` implémente `doc(path).get/set/update/onSnapshot` et `collection(path).get/onSnapshot/doc(k)`.
  - Le faux `mcp` implémente `watchTool(server, tool, input, handler, opts)`, qui appelle `handler({type: 'data', result: {payload: [...]}, cache: {storedAt}})` ou `handler({type: 'error', error: {code, retryable}})`, ainsi que `callTool`.
  - Enregistre chaque appel dans `window.__calls`.
- `harness.mjs` exporte `openPage(browser, {device: 'iPhone 15 Pro Max' | {width, height}, theme?: 'dark'|'light', reducedMotion?: boolean, fake: object})`. La page est servie depuis `extensions/dashboard/page/` par un petit serveur `node:http` local, et `fake-claude.js` est injecté avant les scripts avec `addInitScript`.
- Pour les captures, `deviceScaleFactor: 1` (elles ne sont regardées que par l'agent).

- [ ] **Étape 1 : écrire le test qui échoue**

Le test `smoke` ouvre la page à 430×932 et à 1440×900, et vérifie :
- `document.title === 'Cap'` ;
- `#nav` est visible ;
- `scrollWidth <= clientWidth` sur `document.documentElement` ;
- aucune erreur console.

- [ ] **Étape 2 : lancer et vérifier l'échec**

Commande : `node --test extensions/dashboard/test/page/`. Le projet n'a pas `@playwright/test` : les tests de page utilisent `node:test` et la bibliothèque `playwright` déjà installée (`chromium.launch()`, sans option).

- [ ] **Étape 3 : implémenter le squelette**

Le squelette comprend :
- la coquille de la page ;
- un routage par `location.hash`, avec les noms `accueil`, `offres`, `candidatures`, `planning`, `messages`, `analytique`, `reglages` ;
- un menu latéral au-dessus de 900 px et une barre d'onglets en bas en dessous. Sur iPhone, la barre montre Accueil, Offres, Candidatures, Messages et « Plus » ; « Plus » ouvre Planning, Analytique et Réglages ;
- les jetons de couleur `light-dark()` et les variantes `data-theme`.

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): page shell, navigation and Playwright harness`

---

### Tâche 6 : données de la page (base, générations, demandes, préférences)

**Fichiers :**
- Créer : `extensions/dashboard/page/js/data.js` (expose `globalThis.CapData`)
- Test : `extensions/dashboard/test/page/data.test.mjs`

**Interfaces :**
- Consomme : le faux `db` (tâche 5) et la forme des documents de la tâche 3.
- Produit, sur `CapData` :
  - `start(onChange: (state) => void): void`. `state` vaut `{status: 'loading'|'ok'|'empty'|'unavailable', snapshot: Snapshot|null, pending: Request[], prefs: {weekly_goal: number, accent: string, reduced_motion: boolean}, synced_at: string|null}`.
    - Délai de 10 s pour passer de `loading` à `unavailable`.
    - Un seul abonnement par requête.
    - La génération affichée n'est remplacée que lorsque `snapshot/meta` et toutes ses `parts` portent la même `generation`.
  - `requestStatus(ref: number, to_status: string): Promise<void>` et `requestNote(ref: number, note: string): Promise<void>` : écrivent `requests/{crypto.randomUUID()}` avec `created_at: new Date().toISOString()` et `state: 'pending'`.
  - `savePrefs(partial): Promise<void>` : écrit `settings/prefs`. Valeurs par défaut : `{weekly_goal: 3, accent: 'corail', reduced_motion: false}`.
  - `markHandled(messageId: string): Promise<void>` et `handledIds(): Set<string>` (collection `handled`).

- [ ] **Étape 1 : écrire les tests qui échouent** (dans la page, avec le faux `db`)

1. Ancienne génération G1 complète, et nouvelle génération G2 dont seul `snapshot/meta` est présent : `state.snapshot.generation === G1`. Après l'ajout des parties de G2 : `G2`.
2. Base vide : `status === 'empty'`.
3. `claude.use('db')` renvoie `null` : `status === 'unavailable'` en moins de 11 s, avec des minuteries simulées par `page.clock`.
4. `requestStatus(3, 'Interview')` produit un document `requests/*` avec `state: 'pending'`.
5. `savePrefs({weekly_goal: 4})`, suivi d'une nouvelle génération d'instantané : `prefs.weekly_goal === 4`, donc l'objectif n'est pas écrasé.

- [ ] **Étape 2 : lancer et vérifier l'échec**

- [ ] **Étape 3 : implémenter `data.js`**

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): db layer with generation-safe snapshot reads`

---

### Tâche 7 : écrans Accueil, Offres, Candidatures et Analytique

**Fichiers :**
- Créer : `extensions/dashboard/page/js/ui.js` (échappement, compteurs animés, notifications brèves, boîte de dialogue maison), `page/js/charts.js`, `page/js/screens/accueil.js`, `offres.js`, `candidatures.js`, `analytique.js`
- Modifier : `page/index.html`, `page/css/app.css`
- Test : `extensions/dashboard/test/page/screens.test.mjs`

**Interfaces :**
- Consomme : `CapData.start`, `requestStatus`, `requestNote` (tâche 6) ; `Snapshot` (tâche 2).
- Produit :
  - `CapUI.esc(s): string` ; `CapUI.safeHref(url): string|null` (`https://` uniquement) ; `CapUI.countUp(el, to, {reduced})` ;
  - `CapCharts.area(svg, series, opts)`, `CapCharts.ring(el, value, max)`, `CapCharts.donut(svg, parts)` et `CapCharts.spark(svg, points)`. Chaque graphique est dessiné à la taille réelle en pixels avec un `ResizeObserver` nommé. Les barres et l'entonnoir sont des lignes HTML en largeur en %.
  - Chaque écran : `Screens.<nom>.render(root: HTMLElement, state, ctx)`.

**Contenu exigé** (spécification § 6.3) :
- **Accueil :**
  - salutation selon l'heure de Paris (« Bonjour », « Bon après-midi », « Bonsoir »), suivie de `profile.first_name` s'il existe ;
  - anneau de l'objectif hebdomadaire : nombre d'`applied_on` dans la semaine ISO de Paris, sur `prefs.weekly_goal` ;
  - 4 cartes : envoyées (`Applied` et au-delà), taux de réponse, entretiens, offres reçues ;
  - bloc « À faire » : messages à traiter (tâche 8), `followups_due`, prochain entretien (tâche 8), et offres dont `closes_at` tombe à 7 jours ou moins, avec une icône de flamme en SVG (pas d'emoji) ;
  - mini-semaine ;
  - date de synchronisation.
- **Offres :** liste triée par note, filtre texte, liens `https://` uniquement, panneau de résumé de rapport.
- **Candidatures :**
  - filtres par statut ;
  - tableau `.stack` sur téléphone ;
  - vue en colonnes par statut au-dessus de 1100 px ;
  - fiche détaillée avec « Changer le statut » (liste des statuts canoniques) et « Ajouter une note » ;
  - les demandes en attente sont affichées sur la ligne concernée.
- **Analytique :** courbe `timeline` avec choix 7 j, 30 j ou Tout ; entonnoir ; anneau par statut ; taux de réponse.
- États vides rédigés en français pour chaque écran.

- [ ] **Étape 1 : écrire les tests qui échouent**

1. Avec l'instantané des fixtures (produit par `export.mjs` dans le test), Accueil affiche 3 sur 3 si 3 `applied_on` tombent dans la semaine du 23 au 29/11/2026, avec l'horloge simulée au 27/11/2026.
2. L'entreprise `<img src=x onerror=alert(1)>` apparaît en texte : `page.locator('text=<img src=x')` est visible, aucun `img[src=x]` n'existe, et aucune boîte de dialogue ne s'ouvre.
3. Une URL `javascript:alert(1)` dans une offre ne produit aucun `a[href^="javascript"]`.
4. Changer le statut de la candidature n° 3 vers Interview écrit une demande `pending` et affiche « En attente de synchronisation ».
5. Instantané vide : chaque écran affiche son état vide, sans erreur console.
6. À 360, 430, 720 et 1440 px, en thème clair, sombre et sans `data-theme` : pas de défilement horizontal ; une capture par écran dans `os.tmpdir()/cap-shots/`, hors du dépôt.

- [ ] **Étape 2 : lancer et vérifier l'échec**

- [ ] **Étape 3 : implémenter les écrans, les graphiques et le style**

Le style suit la spécification § 6.5 et commence par le commentaire de six lignes VOICE, IDEA, PICTURE, COLOUR, TYPE et LAYOUT.
- Verre dépoli avec repli opaque `@supports not (backdrop-filter: blur(1px))`.
- Accent par `@property --acc`, avec 5 accents : corail `#ff5a4e`, vert d'eau `#14b8a6`, violet `#7c5cff`, bleu `#2f6bff`, ambre `#f59e0b`. Ajuster si le contraste AA n'est pas atteint.
- Les animations de la § 6.5 sont toutes coupées sous `prefers-reduced-motion` ou `prefs.reduced_motion`, et aucune n'anime un élément filtré par `backdrop-filter`.

- [ ] **Étape 4 : relancer, les tests doivent passer** ; regarder une fois les captures à 430 et 1440 px, puis corriger une fois

- [ ] **Étape 5 : commit** `feat(dashboard): home, offers, applications and analytics screens`

---

### Tâche 8 : Outlook en direct (Messages, Planning, « à traiter »)

**Fichiers :**
- Créer : `extensions/dashboard/page/js/outlook.js` (`globalThis.CapOutlook`), `page/js/screens/messages.js`, `page/js/screens/planning.js`
- Test : `extensions/dashboard/test/page/outlook.test.mjs`

**Interfaces :**
- Consomme : `CapMatch` (tâche 1), `CapData.markHandled` et `handledIds` (tâche 6).
- Produit : `CapOutlook.start(companies, onChange)`. `onChange` reçoit `{status: 'ok'|'unavailable'|'error'|'loading', reason: string|null, messages: Msg[], events: Evt[], storedAt: string|null}`.
  - `Msg = {id, subject, sender, senderName, receivedDateTime, summary, webLink: string|null, company: string|null, handled: boolean}`
  - `Evt = {subject, start: {dateTime, timeZone}, end, location: string|null, company: string|null}`
- Appels, sur le serveur `'Microsoft 365'`. Ces formes d'appel et ce format de réponse ont été observés le 2026-11-27.
  - **E-mails :** un `watchTool('Microsoft 365', 'outlook_email_search', {query: kw, afterDateTime: <ISO il y a 30 j>, limit: 25}, …, {refetchInterval: 300000})` pour chaque `kw` dans `['candidature', 'entretien', 'recrutement', 'interview', 'recruiter']`.
  - Un appel de plus avec `{sender: c.domains[0], afterDateTime, limit: 25}` pour chaque entreprise du tracker qui a un domaine, au plus 10 ; prendre en priorité les statuts `Applied`, `Responded`, `Assessment`, `Interview` et `Offer`.
  - La réponse `payload` est un tableau d'objets `{id, subject, sender, senderName, receivedDateTime, summary, isRead, webLink, …}`. Un dernier élément éventuel `{moreResults, nextOffset}` est à ignorer.
  - On dédoublonne par `id`. On garde les messages pour lesquels `matchCompany` est non nul ou `isJobRelated` est vrai.
  - **Calendrier :** `watchTool('Microsoft 365', 'outlook_calendar_search', {query: '*', afterDateTime: <ISO maintenant>, beforeDateTime: <ISO +14 j>, order: 'oldest', limit: 25}, …)`. On garde les événements pour lesquels `isInterviewEvent` est vrai.
  - Le format d'un événement n'a pas pu être observé (agenda vide). Lire `start`, `end`, `subject` et `location` (texte ou `{displayName}`) de façon défensive, et vérifier sur le premier vrai événement.
- `claude.use('mcp')` vaut `null` : `status: 'unavailable'` avec le texte « Outlook n'est pas accessible depuis cet appareil ». Un événement d'erreur donne `status: 'error'` avec un `reason` lisible selon `error.code`. Un refus d'autorisation efface les données affichées.
- **Messages :** groupés par entreprise, plus un groupe « Non rattachés ». Lien « Ouvrir dans Outlook » vers `webLink`, si `safeHref` l'accepte. Bouton « Marquer comme traité ». Fraîcheur affichée à partir de `storedAt`.
- **Planning :** semaine en colonnes au-dessus de 900 px, liste par jour en dessous. On y voit les entretiens Outlook et les `followups_due` de l'instantané, avec l'heure affichée dans le `timeZone` fourni.

- [ ] **Étape 1 : écrire les tests qui échouent**

1. Le faux `mcp` renvoie 3 messages (un de `rh@acme.fr`, une promo « Black Friday », un « Votre candidature » d'un domaine inconnu) et un élément `{moreResults: true}`. Messages affiche Acme (1) et Non rattachés (1), sans la promo.
2. Un objet `<script>alert(1)</script>` s'affiche en texte. Un `webLink` en `javascript:` ne produit aucun lien.
3. Avec `mcp` en mode `'null'`, Messages et Planning affichent « Outlook n'est pas accessible depuis cet appareil », et Accueil s'affiche quand même.
4. Avec `mcp` en mode `'error'` et `code: 'forbidden'`, le message d'erreur s'affiche et aucune donnée précédente ne reste visible.
5. Après « Marquer comme traité » sur le message Acme, le compteur « Messages à traiter » d'Accueil passe de 2 à 1, et `handled/{id}` est écrit.
6. `window.__calls` contient uniquement les outils `outlook_email_search` et `outlook_calendar_search`.

- [ ] **Étape 2 : lancer et vérifier l'échec**

- [ ] **Étape 3 : implémenter `outlook.js`, `messages.js` et `planning.js`**

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): live Outlook messages and planning`

---

### Tâche 9 : recherche ⌘K, réglages, thèmes et animations d'ouverture

**Fichiers :**
- Créer : `extensions/dashboard/page/js/palette.js`, `page/js/screens/reglages.js`
- Modifier : `page/css/app.css`, `page/js/app.js`
- Test : `extensions/dashboard/test/page/palette.test.mjs`

**Interfaces :**
- Consomme : l'instantané (tâche 6), `CapData.savePrefs`, et le routage de la tâche 5.
- Produit : `CapPalette.open()` et `close()`.
  - Ouverture par ⌘K ou Ctrl+K, et par un bouton loupe sur téléphone.
  - Recherche locale sans accents ni casse dans les entreprises, les postes, les offres et les noms d'écran.
  - Navigation au clavier (↑ ↓ Entrée Échap) et piège du focus.

**Réglages :**
- 5 accents ;
- objectif hebdomadaire de 1 à 10 ;
- réduction des animations ;
- date de dernière synchronisation ;
- une ligne expliquant que les modifications sont appliquées par Claude à la prochaine session.

**Animation d'ouverture :** révélation en cercle par `clip-path` et levée de flou, en moins de 900 ms, une seule fois par chargement, et sautée en mouvement réduit.

- [ ] **Étape 1 : écrire les tests qui échouent**

1. `Control+K` puis la saisie `acme` donnent un premier résultat « Acme » ; Entrée ouvre sa fiche dans Candidatures.
2. Échap ferme la palette et rend le focus à l'élément précédent.
3. Choisir l'accent « bleu » change `getComputedStyle(root).getPropertyValue('--acc')` et écrit `settings/prefs`.
4. Sous `reducedMotion: 'reduce'`, aucun élément n'a d'animation en cours (`document.getAnimations().length === 0` après 100 ms).

- [ ] **Étape 2 : lancer et vérifier l'échec**

- [ ] **Étape 3 : implémenter**

- [ ] **Étape 4 : relancer, les tests doivent passer**

- [ ] **Étape 5 : commit** `feat(dashboard): command palette, settings, themes and opening motion`

---

### Tâche 10 : publication, déclaration des capacités et première synchronisation

Cette tâche a besoin d'une session interactive avec le candidat. Elle ne doit pas être confiée à un sous-agent.

**Fichiers :**
- Créer : `extensions/dashboard/README.md`. On y décrit les commandes de synchronisation, de publication et d'application des demandes. Il ne contient ni slug, ni donnée personnelle.
- Créer dans la **couche utilisateur** (dépôt privé, pas ce dépôt) :
  - `{DATA_ROOT}/data/dashboard.json`, qui vaut `{"slug": "…"}` ;
  - une règle dans `{DATA_ROOT}/modes/_custom.md` : « Au début de chaque session career-ops : (1) `db_list requests` → fichier temporaire → `node extensions/dashboard/apply-requests.mjs --in …` → `db_write` des résultats ; (2) `node extensions/dashboard/export.mjs` → `db_write` de chaque document, `snapshot/meta` en dernier. »

**Étapes :**
- [ ] Lire `describe_capabilities` pour `desktop`, `db` (avec `types: true`) et `mcp`. Corriger `data.js` et `outlook.js` si une signature diffère du faux banc d'essai, puis relancer toute la suite.
- [ ] Publier avec `publish_files` : `as` vaut le chemin sous `page/`, le titre « Cap », l'icône « chart ».
- [ ] Déclarer les capacités :

```json
{"db":{"rules":[{"path":"snapshot","read":"owner","write":"owner"},{"path":"requests","read":"owner","write":"owner"},{"path":"handled","read":"owner","write":"owner"},{"path":"settings","read":"owner","write":"owner"}]},
 "user":{},
 "mcp":{"servers":[{"server":"Microsoft 365","tools":["outlook_email_search","outlook_calendar_search"]}]},
 "desktop":{}}
```

- [ ] Première synchronisation : lancer `export.mjs`, puis `db_write` des documents, avec `snapshot/meta` en dernier. Vérifier avec `db_get snapshot/meta`.
- [ ] Enregistrer le slug dans `data/dashboard.json`, ajouter la règle dans `_custom.md`, puis commit et push du dépôt privé.
- [ ] Envoyer le lien au candidat. C'est lui qui vérifie l'affichage sur son iPhone et son PC, ainsi que le consentement Outlook. Corriger ce qu'il signale.
- [ ] Commit du dépôt de code : `docs(dashboard): README for sync and publish`.

---

## Couverture de la spécification

| Spécification | Tâche |
|---|---|
| § 6.1 synchronisation descendante | 2, 3, 10 |
| § 6.1 synchronisation montante | 4, 6, 7, 10 |
| § 6.1 Outlook en direct | 8 |
| § 6.1 réponses Outlook vers le tracker par `paste-reply.mjs` et `reply-watch` | hors page : déjà couvert par les modes existants, et la règle de la tâche 10 le déclenche en session |
| § 6.1 bis persistance | 10 (dépend de l'accès au dépôt `career-data`) |
| § 6.2 règles de la base | 10 |
| § 6.3 écrans | 7, 8, 9 |
| § 6.4 valeurs par défaut | 6, 9 |
| § 6.5 langage visuel | 7, 9 |
| § 6.6 / 6.6 bis | 1 à 4, 6, 8 |
| § 6.7 tests | toutes |
