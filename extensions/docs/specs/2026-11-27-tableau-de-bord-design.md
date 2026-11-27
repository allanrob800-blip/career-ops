# Tableau de bord de recherche d'emploi : document de conception

- **Date :** 2026-11-27
- **Statut :** brouillon, en attente de validation par le candidat
- **Projet parent :** fusion career-ops + ai-job-search, sous-projet n° 2 (voir « Feuille de route » en fin de document)

## 1. Intention

Le candidat veut **un seul endroit**, sur PC et sur son iPhone 15 Pro Max personnel, pour savoir où en est sa recherche d'emploi et quoi faire aujourd'hui :

- ses candidatures et leur état ;
- les nouvelles offres à évaluer ;
- les réponses des recruteurs ;
- ses entretiens et ses relances.

Il a fourni une vidéo de référence (publicité de l'agence Andromis pour leur SaaS « HALO »). Il en attend le **niveau de finition** : verre dépoli, dégradés chauds, chiffres et graphiques animés, recherche ⌘K, planning, messagerie en direct, thème de couleur au choix, transitions animées.

Pourquoi : career-ops produit déjà les données (tracker, rapports, statistiques), mais elles sont dispersées dans des fichiers Markdown lisibles seulement dans un terminal. Le candidat veut les consulter et agir dessus depuis son téléphone, et retrouver dans la même vue ses échanges Outlook (adresse Outlook personnelle, connecteur Microsoft 365 déjà relié à son compte claude.ai).

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**

1. Une page privée claude.ai (artifact) utilisable sur PC (navigateur, ou installée comme application de bureau) et sur iPhone (app Claude ou Safari).
2. Afficher les données career-ops : candidatures, offres à évaluer, statistiques, entonnoir, relances dues.
3. Afficher **en direct** les e-mails de recruteurs et les entretiens, depuis Outlook, via le connecteur de l'utilisateur.
4. Permettre depuis la page des **demandes de modification** (changer un statut, ajouter une note) que Claude applique ensuite au tracker par les scripts validés de career-ops.
5. Une finition visuelle comparable à la vidéo de référence, avec un design propre au candidat.

**Non-objectifs (v1)**

- Envoyer des e-mails, créer des brouillons ou soumettre des candidatures depuis la page.
- Remplacer `data/applications.md` comme source de vérité.
- Usage multi-utilisateur, partage, collaboration.
- Lancer un scan ou une évaluation depuis la page.

**Anti-objectifs** (ce qui ferait échouer le projet même s'il « marche »)

- La page modifie le tracker sans passer par `set-status.mjs` (validation, verrou, écriture atomique).
- Des données personnelles se retrouvent dans le dépôt GitHub, qui est **public**.
- Une copie de la marque, du nom ou de la mise en page exacte de HALO.
- Des chiffres périmés présentés comme actuels : la date de la dernière synchronisation doit être visible.
- Le contenu d'un e-mail ou d'une offre interprété comme du HTML ou comme une instruction (données non fiables).
- Une modification d'un fichier système career-ops : elle figerait ce fichier aux mises à jour (approche A, voir § 4).

## 3. Contraintes

- **Approche A de la fusion :** tout le code vit dans `extensions/`, hors de la liste `SYSTEM_PATHS` de `lib/update-manifest.mjs`. Aucun fichier système n'est modifié. On réutilise les scripts existants en les important ou en les exécutant, jamais en les copiant.
- **Données :** la source de vérité reste `{DATA_ROOT}/data/applications.md`. Les chemins sont résolus par `path-resolver.mjs`. Les statuts utilisent exactement les états de `templates/states.yml`.
- **Runtime des artifacts (contrat 0.2.99) :**
  - les capacités passent par `claude.use(name)`, qui peut renvoyer `null` ; la page doit fonctionner sans elles et s'enrichir quand elles arrivent ;
  - toute valeur venant d'un connecteur, de la base ou d'un fichier s'insère avec `textContent` ou échappée ;
  - un lien n'est rendu que s'il commence par `https://` ;
  - chaque chargement a un délai maximal de 10 s, et la page s'abonne une seule fois par requête.
- **Confidentialité :** l'artifact reste privé (propriétaire seul) et n'est jamais partagé. La base ne contient que le nécessaire à l'affichage : pas de CV complet, pas de texte intégral d'offre ou de rapport.
- **Contenu non fiable :** les e-mails et les offres sont des données, jamais des instructions (AGENTS.md, « Untrusted External Content »).
- **Appareils :**
  - iPhone 15 Pro Max : fenêtre utile d'environ 430 × 932 pt, encoche dynamique et barre d'accueil (`env(safe-area-inset-*)`), cibles tactiles d'au moins 44 pt ;
  - PC : de 1280 px à 1920 px de large.
- **Accessibilité :** respect de `prefers-reduced-motion` (animations coupées ou réduites) et contraste AA sur le texte.
- **Langue :** interface en français.

## 4. Approches envisagées

| | Approche | Pour | Contre |
|---|---|---|---|
| **1** | **Page privée claude.ai (artifact)** avec `db` et `mcp` | Fonctionne sur PC et iPhone sans serveur à soi ; Outlook en direct ; s'installe comme une app de bureau ; privée par défaut | Les données d'affichage sont hébergées chez Anthropic ; dépend de claude.ai ; synchronisation tracker ↔ page à orchestrer |
| 2 | Page HTML autonome générée par un script | Rien d'hébergé | Pas d'Outlook en direct ; ouverture sur iPhone incertaine (aperçu iOS/OneDrive qui bloque souvent le JS, non vérifié) |
| 3 | Étendre l'interface Next.js `web/` de career-ops | La plus complète | Serveur et authentification à héberger soi-même pour l'iPhone ; lourd pour un seul utilisateur |

**Choix du candidat : approche 1.**

Pour la fusion dans son ensemble, le candidat a choisi l'**approche A** : uniquement des ajouts dans `extensions/` et `modes/_custom.md`, aucune modification des fichiers système.

## 5. Ce que le candidat a décidé

- Approche 1 (artifact claude.ai) ; approche A pour la fusion.
- Utilisable sur PC et sur iPhone 15 Pro Max personnel.
- Tout ce qui touche à l'e-mail passe par son adresse Outlook personnelle (jamais écrite dans le dépôt).
- **Pas** d'e-mails envoyés par Claude, même vers sa propre adresse : le tableau de bord remplace les notifications par e-mail.
- Style et fonctions inspirés de la vidéo de référence (§ 1), transposés à la recherche d'emploi.
- **Persistance des données :** un dépôt GitHub **privé** séparé contient toute la couche utilisateur (§ 6.1 bis).

## 6. Conception

### 6.1 Architecture et flux de données

```
                 session Claude Code (conteneur)
 data/applications.md ─┐
 data/pipeline.md ──────┤  extensions/dashboard/export.mjs
 reports/*.md (en-têtes)┼──► (lecture seule, réutilise tracker-parse,
 stats / funnel /       │     stats, funnel-stages, followup-cadence)
 followup-cadence ──────┘            │ snapshot JSON
                                     ▼
                 Claude ──db_write──► base de l'artifact : snapshot/current
                                     ▲            requests/{id}
 set-status.mjs ◄── Claude ◄─db_get──┘ (demandes de modif. de la page)

 Page artifact (PC / iPhone)
   ├─ lit snapshot/current (onSnapshot)
   ├─ écrit requests/{id} (changement de statut, note)
   └─ mcp (connecteur Microsoft 365, lecture seule) :
        outlook_email_search    → onglet Messages
        outlook_calendar_search → onglet Planning
```

**Synchronisation descendante (tracker → page)**

1. `node extensions/dashboard/export.mjs` produit un instantané JSON sur la sortie standard.
2. Claude l'écrit dans la base avec `db_write` (document `snapshot/current`).
3. Quand : au début de chaque session, après un `scan`, après une évaluation, et à la demande (« synchronise le tableau de bord »).

L'instantané contient au minimum :
- `generated_at` (horodatage) ;
- les candidatures : n°, date, entreprise, poste, note, statut canonique, lien de l'offre, numéro de rapport, date du dernier changement, prochaine relance prévue ;
- les offres en attente du pipeline (URL, entreprise, poste si connu, note si déjà évaluée) ;
- les statistiques et l'entonnoir (sortie de `stats.mjs`) ;
- les relances dues (sortie de `followup-cadence.mjs`) ;
- les offres dont la date limite (`closes_at`) tombe sous 7 jours, quand elle est connue ;
- l'objectif hebdomadaire (§ 6.4).

**Synchronisation montante (page → tracker)**

1. La page écrit un document `requests/{id}` : `{type: "status" | "note", ref: n° de tracker ou de rapport, to_status?, note?, created_at, state: "pending"}`.
2. En début de session, Claude lit les demandes `pending` et applique chacune via `node set-status.mjs`.
3. Claude marque chaque demande `applied` (avec la date) ou `rejected` (avec la raison renvoyée par le script), puis resynchronise l'instantané.
4. La page affiche les demandes en attente (« en attente de synchronisation ») et leur résultat.

Une demande n'est jamais appliquée sans passer par le script. Une demande ambiguë est soumise au candidat.

**Outlook en direct**

- La page déclare la capacité `mcp` avec le serveur « Microsoft 365 » et **uniquement** des outils de lecture (`outlook_email_search`, `outlook_calendar_search`).
- Les arguments exacts de ces outils sont relevés avec `describeTool` pendant la construction : ne pas les deviner.
- La page utilise `watchTool` avec un `refetchInterval` raisonnable (laissé au constructeur, de l'ordre de quelques minutes) et affiche la fraîcheur (`cache.storedAt`).

**Réponses des recruteurs vers le tracker** (hors page, pendant une session)

- Claude lit les e-mails via le connecteur.
- Il normalise chaque réponse pertinente avec `paste-reply.mjs --file`, ce qui écrit `data/reply-candidates.json`.
- Il lance le mode `reply-watch`, qui propose les changements de statut que le candidat valide.
- Raison de ce chemin : le format `data/reply-proposals/` n'accepte que `source.kind = "gmail"` (`lib/reply-proposals.mjs:40`) et le modifier violerait l'approche A.

### 6.1 bis Persistance de la couche utilisateur (choix du candidat)

Les sessions cloud repartent d'un conteneur vide. La couche utilisateur vit donc dans un **dépôt GitHub privé** séparé, créé par le candidat (nom suggéré : `career-data`).

- **Contenu du dépôt privé :** `cv.md`, `config/profile.yml`, `modes/_profile.md`, `modes/_custom.md`, `portals.yml`, `data/`, `reports/`, `jds/`, `interview-prep/`, `output/` et le reste de la couche utilisateur de `DATA_CONTRACT.md`.
- **Liaison au code :** career-ops la gère nativement par le fichier marqueur `.career-ops-data` (ignoré par git, à recréer dans chaque conteneur) ou par `CAREER_OPS_DATA_DIR` (DATA_CONTRACT.md → « Custom Data Directory »). Clone conseillé : `../career-data` à côté du dépôt de code ; marqueur `../career-data`.
- **Début de session :** ajouter le dépôt privé à la session (`add_repo`), le cloner, écrire le marqueur, vérifier avec `node doctor.mjs --json` que `data_root` pointe bien dessus.
- **Fin de session :** commit et push du dépôt privé après tout changement de la couche utilisateur.
- **Automatisation possible plus tard :** un script d'initialisation de l'environnement cloud. Hors périmètre de ce document.
- **Garde-fou :** avant chaque commit du dépôt de code (public), vérifier qu'aucun fichier de la couche utilisateur n'y est suivi. Ils sont normalement déjà ignorés par `.gitignore`.

### 6.2 Sécurité de la base

- Règles d'accès : lecture et écriture réservées au propriétaire sur `snapshot` et `requests`. L'artifact n'est pas partagé.
- `data/users/<id>/` est privé même pour le propriétaire : on ne l'utilise pas pour l'instantané, que Claude doit pouvoir écrire.
- Aucun secret dans la base.
- Les données de la base sont traitées comme non fiables à l'affichage, comme tout le reste.

### 6.3 Écrans

Navigation : menu latéral sur PC ; barre d'onglets en bas sur iPhone (5 onglets visibles, le reste sous « Plus »).

| Écran | Contenu |
|---|---|
| **Accueil** | Salutation selon l'heure (« Bonjour {prénom} », prénom lu depuis `config/profile.yml` à l'export) ; carte héros avec anneau de progression de l'objectif hebdomadaire ; 4 cartes de chiffres animés avec mini-courbes (envoyées, taux de réponse, entretiens, offres reçues) ; bloc « À faire » (réponses Outlook non traitées, relances dues, prochain entretien, offres qui ferment sous 7 jours 🔥) ; mini-calendrier de la semaine |
| **Offres** | Offres à évaluer et offres évaluées non postulées, triées par note ; filtres ; lien vers l'offre et le rapport |
| **Candidatures** | Vue tableau (PC) ou cartes (iPhone) ; filtres par statut ; vue en colonnes par statut sur PC ; fiche détaillée avec historique, prochaine relance, boutons « changer le statut » et « ajouter une note » (→ `requests/`) |
| **Planning** | Semaine en colonnes (PC) ou liste par jour (iPhone) ; entretiens depuis l'agenda Outlook ; relances dues issues de l'instantané |
| **Messages** | E-mails Outlook liés à la recherche, en fil de discussion par entreprise ; lecture seule ; lien « ouvrir dans Outlook » |
| **Analytique** | Courbe des candidatures dans le temps avec choix de période (7 j / 30 j / tout) ; entonnoir ; répartition par statut en anneau ; taux de réponse |
| **Réglages** | Couleur du thème (5 accents) ; objectif hebdomadaire ; mode réduit des animations ; date de dernière synchronisation |

**Recherche ⌘K** (Ctrl+K sur PC, bouton loupe sur iPhone) : entreprises, postes, offres, écrans. Recherche locale dans l'instantané, sans appel réseau.

**Messages liés à la recherche** — filtre par défaut :
- l'expéditeur appartient au domaine d'une entreprise présente dans le tracker ;
- OU le message contient des mots-clés de candidature (candidature, entretien, recrutement, offre, application, interview) ;
- sur les 30 derniers jours.

### 6.4 Valeurs par défaut (choix de Claude, modifiables)

- **Objectif hebdomadaire :** 3 candidatures, réglable dans la page. Cohérent avec la règle career-ops « peu de candidatures, bien ciblées ».
- **Nom de l'application :** provisoire, « Cap ». Pas de nom ni de logo emprunté à HALO.
- **Accent par défaut :** corail ; 4 autres accents au choix (vert d'eau, violet, bleu, ambre).

### 6.5 Langage visuel

- Fond chaud flouté ; panneaux en verre dépoli (`backdrop-filter: blur() saturate()` avec un repli opaque si non supporté) ; coins arrondis généreux ; ombres douces.
- Thème piloté par une propriété CSS d'accent enregistrée (`@property`), ce qui permet une transition animée au changement de couleur.
- **Animations :**
  - ouverture : révélation en cercle (`clip-path`) et levée de flou ;
  - chiffres comptés jusqu'à leur valeur ;
  - courbes SVG qui se redessinent au changement de période ;
  - transitions entre écrans (légère rotation et flou) ;
  - apparition décalée des cartes.
- Tout est réduit ou coupé sous `prefers-reduced-motion`.
- Mode sombre : non requis en v1 (laissé au constructeur).

### 6.6 Code et emplacement

- `extensions/dashboard/export.mjs` : exportateur, en lecture seule ; aucune écriture dans `data/`.
- `extensions/dashboard/page/` : sources de la page (HTML, CSS, JS, sans étape de build), publiées avec `publish_files`.
- `extensions/dashboard/README.md` : comment synchroniser et republier.
- `extensions/docs/specs/` : ce document.
- Aucune donnée personnelle dans ces fichiers, puisque le dépôt est public. L'identifiant (slug) de l'artifact n'est pas secret, mais on le garde hors du dépôt : il est noté dans `{DATA_ROOT}/data/dashboard.json` (couche utilisateur, ignorée par git).

### 6.6 bis Décisions de détail (choix de Claude, issus de la relecture)

- **Message « à traiter » :** un e-mail lié à la recherche est « à traiter » tant que son identifiant n'est pas dans la collection `handled/{messageId}`. La page y écrit quand le candidat touche « marquer comme traité ». Claude y écrit quand il a passé le message dans `paste-reply.mjs` / `reply-watch`. Mêmes règles d'accès que `snapshot` (propriétaire seul).
- **Rattacher les e-mails et les événements aux entreprises :** le tracker ne contient pas de domaines. Un message ou un événement est rattaché à une entreprise du tracker quand le nom de l'entreprise apparaît dans l'expéditeur (nom affiché ou domaine), dans l'objet, ou dans le titre ou la description de l'événement. La comparaison ignore la casse, les accents et les suffixes juridiques (SAS, SA, Inc, GmbH…). L'instantané transporte, pour chaque entreprise, son nom normalisé et les domaines déductibles de l'URL de l'offre quand ce n'est pas un hébergeur d'ATS. Un événement compte comme entretien s'il est rattaché à une entreprise, ou si son titre contient entretien, interview, call, visio, échange ou rencontre. Ce qui n'est rattaché à rien mais correspond aux mots-clés de candidature s'affiche dans un groupe « Non rattachés ».
- **Objectif hebdomadaire :** il appartient à la page (document `settings/prefs` dans la base). `export.mjs` ne l'écrit jamais, donc une synchronisation ne l'écrase pas. Compte : les passages au statut `Applied` dans la semaine ISO en cours (du lundi au dimanche, heure de Paris), lus dans `data/status-log.tsv`. Si ce fichier est absent, on compte les lignes `Applied` dont la date tombe dans la semaine. L'instantané transporte donc les dates de passage à `Applied`.
- **Lien vers le rapport :** l'instantané contient pour chaque rapport un résumé court, sans le texte intégral : note, archétype, légitimité, 2 à 3 points forts et 2 à 3 lacunes repris des en-têtes et blocs du rapport. La page l'affiche dans un panneau.
- **Date d'une demande faite depuis la page :** elle est appliquée avec `set-status.mjs --on <date de created_at>`, pour que l'historique, la cadence des relances et l'objectif hebdomadaire reflètent le jour où le candidat a agi.
- **Déclenchement de la synchronisation :** une règle dans `modes/_custom.md` (couche utilisateur, donc conservée dans le dépôt privé) demande à Claude, au début de chaque session career-ops, de traiter les demandes `pending`, puis de régénérer et d'écrire l'instantané.

### 6.7 Tests et vérification

- `export.mjs` : tests `node:test` sur un tracker d'exemple (fixtures sans données réelles) ; tracker vide ; statuts non canoniques ; dates manquantes.
- Page :
  - captures Playwright au format iPhone 15 Pro Max (profil d'appareil Playwright) et à 1440 px de large ;
  - avec `prefers-reduced-motion` ;
  - avec la base vide ;
  - avec `mcp` indisponible (`null`) ;
  - avec une erreur de l'outil Outlook.
- Échappement : un instantané et un faux e-mail contenant `<script>` et des liens `javascript:` ne doivent rien exécuter ni rendre de lien.
- Vérification réelle sur l'iPhone du candidat : c'est lui qui confirme.

## 7. Ce qui reste au constructeur

- Les arguments exacts des outils Outlook (via `describeTool`) et la requête de filtrage des e-mails.
- L'intervalle de rafraîchissement Outlook.
- Le découpage des fichiers de la page et la bibliothèque de graphiques (SVG fait main de préférence, sans dépendance externe).
- La forme exacte de l'instantané, dans le respect du § 6.1.
- Le mode sombre.

## 8. Risques et inconnues

- La capacité `mcp` dans l'app Claude sur iPhone n'a pas été vérifiée. Repli : la page fonctionne sans Outlook, avec l'instantané seul.
- La taille maximale d'un document de la base est inconnue. Si l'instantané dépasse, le découper par collection (candidatures, offres, statistiques).
- Les demandes de consentement du connecteur au premier usage, sur chaque appareil.
- Tant que le candidat n'a pas fourni son CV et son profil, il n'y a aucune donnée réelle : le développement se fait sur des données d'exemple.

## 9. Feuille de route de la fusion (rappel)

1. CV et profil du candidat (onboarding career-ops).
2. **Ce tableau de bord**, avec la lecture d'Outlook.
3. Qualité des candidatures : règle anti-reprise des phrases de l'offre, vérification du PDF, coupe par pertinence, relecture de la lettre.
4. Critères d'évaluation : barrière des langues, profil de travail, salaires de référence, cache de recherche entreprise, alerte de date limite.
5. Le reste (Notion, réinitialisation, etc.).
