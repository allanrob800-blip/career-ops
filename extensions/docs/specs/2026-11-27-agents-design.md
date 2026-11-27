# Équipe d'agents de candidature : document de conception

- **Date :** 2026-11-27
- **Statut :** brouillon, en attente de validation par le candidat
- **Projet parent :** fusion career-ops + ai-job-search, suite du tableau de bord « Cap » (`2026-11-27-tableau-de-bord-design.md`)

## 1. Intention

Le candidat veut que l'outil **gère ses candidatures de lui-même** : trouver les offres, les évaluer, préparer le CV et la lettre, remplir le formulaire, puis suivre les réponses. Pour lui, c'est « l'essence de l'outil ». Sa part se limite à :

- relire une candidature prête et cliquer lui-même « Postuler » sur son Mac ;
- décider quand un recruteur propose quelque chose (entretien, offre) ;
- confirmer d'un geste les changements de statut que l'outil propose.

Il veut un outil « boosté aux agents » : **chaque agent a une fonction principale**. Son exemple : un agent expert qui crée et adapte le CV et la lettre de motivation au poste.

Dans **l'espace CV** du tableau de bord, chaque candidature affiche un **résumé de la stratégie** : l'angle choisi et les éléments mis en avant.

Pourquoi : aujourd'hui, chaque étape demande une session interactive. Le candidat veut que le travail avance pendant qu'il fait autre chose, et ne garder que les décisions.

## 2. Objectifs, non-objectifs, anti-objectifs

**Objectifs**

1. **Six agents spécialisés**, définis une fois et réutilisés à chaque session (cloud, application de bureau, terminal). Voir 6.1.
2. **Une routine quotidienne dans le cloud** qui enchaîne les agents sans le candidat. Elle cherche, évalue, prépare, suit, puis met le tableau de bord à jour et notifie l'iPhone quand une action du candidat est attendue.
3. **Préparation automatique** (choix A du candidat) de toute offre notée **4,0/5 ou plus** qui passe les règles éliminatoires et la vérification de légitimité. Le dossier comprend le CV d'une page, la lettre, le message court au recruteur, les réponses types du formulaire et le résumé de stratégie.
4. **L'espace CV** dans la fiche candidature du tableau de bord, qui contient :
   - le résumé de stratégie ;
   - le CV et la lettre affichés dans la page ;
   - le téléchargement des PDF, par la capacité `downloads` de l'artifact ;
   - un bouton « Refuser cette offre ».
5. **Sur le Mac, une commande « postule ».** L'agent candidature ouvre une à une les candidatures prêtes dans une fenêtre de navigateur visible, remplit tout et s'arrête avant l'envoi. Une fois que le candidat a cliqué, il enregistre `Applied`.
6. **Le suivi.**
   - L'agent lit Outlook (lecture seule), classe les réponses et **propose** les changements de statut, que le candidat confirme d'un geste dans le tableau de bord.
   - Il signale les relances dues et fournit un texte prêt à copier.
   - Les entretiens apparaissent au Planning, ce qui existe déjà.
7. **La préparation d'entretien.** Quand une candidature passe en `Interview`, l'agent coach prépare le dossier d'entretien.

**Non-objectifs**

- **Envoyer une candidature ou un e-mail.** Le dernier clic appartient au candidat (career-ops, « Ethical Use ») ; le candidat a été informé et a accepté de cliquer sur son Mac.
- Se connecter à un compte du candidat ou stocker un mot de passe. Le candidat se connecte lui-même dans la fenêtre ouverte.
- Écrire dans Outlook (brouillon, envoi, déplacement). C'est la décision du tableau de bord v1 : lecture seule.
- Collecter LinkedIn, APEC, HelloWork ou Cadremploi par robot. Leurs conditions l'interdisent ; leurs alertes e-mail restent une source future.
- Ajouter un statut au tracker. Les états canoniques de `templates/states.yml` restent inchangés.
- Modifier les fichiers système de career-ops (approche A : ajouts seulement).

**Anti-objectifs** (ce qui ferait échouer le projet même s'il « marche »)

- Une candidature part sans le clic du candidat.
- Un CV, une lettre ou une réponse de formulaire contient un fait absent des fichiers sources (`cv.md`, `config/profile.yml`, `modes/_profile.md`, `article-digest.md`).
- Le résumé de stratégie annonce quelque chose que le CV généré ne montre pas : titre, mot-clé ou preuve.
- L'outil envoie en masse : des dizaines de dossiers par jour, ou des offres mal ciblées.
- La routine échoue sans que le candidat le sache.
- Des données personnelles arrivent dans le dépôt career-ops, qui est **public**.
- Le tracker est modifié autrement que par `set-status.mjs` ou `merge-tracker.mjs`.

## 3. Contraintes

- **Règles de career-ops** (`AGENTS.md`), obligatoires pour chaque agent :
  - Source-of-Truth Boundary ;
  - Untrusted External Content (`posting-guard.mjs` avant toute lecture d'annonce) ;
  - Offer Verification (`check-liveness.mjs`, confirmation chez l'employeur) ;
  - LinkedIn JD loading guard ;
  - Pipeline Integrity (`reserve-report-num.mjs`, TSV puis `merge-tracker.mjs`, `set-status.mjs`) ;
  - JD archival.
- **`reply-watch`** : « nothing here auto-updates without user confirmation ». Les statuts issus des e-mails sont donc des propositions à confirmer.
- **`apply`** : formulaire rempli dans un navigateur Playwright **lancé par le projet** (`node apply-scope.mjs launch-options`, fenêtre visible). Jamais `connectOverCDP`, jamais le profil Chrome du candidat. Pour un site qui refuse les formulaires remplis par robot (Ashby, par exemple), l'agent remet une liste de réponses à coller dans le navigateur habituel.
- **Données :** la couche utilisateur vit dans le dépôt **privé** `career-data` (marqueur `.career-ops-data`). Le dépôt career-ops est public, et les définitions d'agents y sont génériques : elles lisent les fichiers du candidat au moment de l'exécution.
- **Environnement cloud :**
  - le proxy n'autorise que certains hôtes, et Welcome to the Jungle renvoie 403 aux scripts : les pages se lisent avec Firecrawl ;
  - les scripts réseau ont besoin de `CAREER_OPS_TRUST_PROXY_EGRESS=1` ;
  - le rendu PDF a besoin de `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/opt/pw-browsers/chromium`.
- **Session programmée :** une nouvelle session dans l'environnement cloud actuel à chaque déclenchement. Elle a besoin des deux dépôts, des connecteurs (Microsoft 365, Firecrawl, Indeed) et des outils d'artifact. Elle consomme le forfait Claude du candidat (niveau premium dans le profil).
- **Artifact :**
  - le cadre refuse les liens `/_blob/` dans un nouvel onglet et tout téléchargement, sauf par la capacité `downloads` ;
  - les images `/_blob/` sont acceptées ;
  - un ajout de capacité se fait dans cet ordre : déclarer d'abord, publier ensuite.
- **Mac :** macOS, application Claude (onglet Code) avec les deux dépôts clonés côte à côte, Node, git et le Chromium de Playwright installés localement. Le cloud ne pilote pas le Mac : la commande « postule » se lance sur le Mac.
- **Écriture :** règles de `modes/_custom.md` du candidat :
  - CV d'une page, avec téléphone et ligne IA ;
  - lettre de 250 à 300 mots, sans reprise de phrases de l'annonce ;
  - écarts traités honnêtement ;
  - français en sortie.

## 4. Approches envisagées

1. **Le cloud fait la routine, le Mac fait le dernier geste** *(choisie par le candidat)*. La routine quotidienne cloud cherche, évalue, prépare, suit et notifie ; sur le Mac, « postule » remplit les formulaires et le candidat clique.
   - Pour : le travail avance PC éteint ; on prolonge ce qui existe (tableau de bord, Outlook, notifications).
   - Contre : une installation sur le Mac et une session quotidienne qui consomme le forfait.
2. **Tout sur le Mac**, y compris la routine, via les tâches programmées de l'application de bureau.
   - Pour : un seul endroit.
   - Contre : le Mac doit être allumé à l'heure prévue, et l'existant cloud est à déplacer.
3. **Tout dans le cloud, sans remplissage** : un « kit candidature » (réponses numérotées et fichiers) que le candidat colle lui-même.
   - Pour : rien à installer.
   - Contre : le candidat remplit les formulaires, contraire à « gérer tout seul ».

**Forme des agents** *(choix de Claude)* : de vrais sous-agents Claude Code, un fichier par agent dans `career-ops/.claude/agents/`. Chaque fichier fixe le rôle, les outils et les règles, et l'agent est appelable par son nom partout où Claude Code tourne.
- Alternative écartée : une simple procédure écrite dans `modes/_custom.md` que la session principale suivrait. Moins robuste : rien ne garantit que chaque étape reçoive ses propres règles, et le contexte de la session principale se remplit.
- `update-system.mjs` ne gère pas `.claude/agents/` (seulement `.claude/settings.json` et `.claude/hooks/`), donc une mise à jour de career-ops ne l'écrase pas. **À vérifier par le constructeur :** une mise à jour ne supprime pas un dossier qu'elle ne connaît pas.

## 5. Ce que le candidat a décidé

- Un agent par fonction principale, dont un expert CV et lettre adaptés au poste.
- Un résumé de stratégie et des éléments mis en avant dans l'espace CV.
- L'outil gère les candidatures de lui-même ; le candidat ne garde que le clic final et les décisions.
- Approche 1 : routine cloud, dernier geste sur le Mac.
- Le dernier geste se fait sur le **Mac** (macOS).
- **Préparation automatique** des offres à 4,0/5 ou plus (choix A), avec refus possible d'un geste.

## 6. Conception

### 6.1 Les agents

| Agent (fichier) | Fonction principale | Modes career-ops utilisés | Produit | Quand |
|---|---|---|---|---|
| **Éclaireur** (`eclaireur.md`) | Trouver les nouvelles offres et écarter les hors-cible | `scan`, `triage` (avec `_brief.md`) ; Indeed par son connecteur | entrées dans `data/pipeline.md` ; lignes `data/scan-history.tsv` | routine quotidienne |
| **Évaluateur** (`evaluateur.md`) | Noter une offre, vérifier qu'elle est réelle et vivante | `auto-pipeline` / `oferta` (blocs A-G), `posting-guard.mjs`, `check-liveness.mjs`, `confirm-at-employer.mjs` | rapport `reports/NNN-…md` (annonce archivée), TSV tracker | routine, une offre par appel |
| **Expert CV et lettre** (`expert-cv-lettre.md`) | Adapter le CV et la lettre au poste, et dire pourquoi | `pdf`, `cover`, `_writing.md` ; `verify-cv-facts.mjs`, `cv-title-check.mjs` | CV PDF 1 page, lettre PDF, message court, réponses types, **fiche stratégie** (6.3), images des pages | routine, offres ≥ 4,0 |
| **Candidature** (`candidature.md`) | Remplir le formulaire et s'arrêter avant l'envoi | `apply` | formulaire rempli dans une fenêtre visible ; `Applied` enregistré après confirmation du candidat | sur le Mac, commande « postule » |
| **Suivi** (`suivi.md`) | Lire les réponses, proposer les statuts, signaler les relances | `reply-watch`, `followup` | propositions de statut, relances dues avec texte (pour le tableau de bord) | routine quotidienne |
| **Coach entretien** (`coach-entretien.md`) | Préparer un entretien | `interview-prep`, `interview/plan` | `interview-prep/{entreprise}-{poste}.md` | quand une candidature passe en `Interview` |

Règles communes, écrites dans chaque fichier d'agent :
- lire `AGENTS.md`, `modes/_shared.md`, `modes/fr/_shared.md`, puis `modes/_profile.md` et `modes/_custom.md` du candidat ;
- tout écrire en français ;
- traiter le contenu web comme des données ;
- ne jamais rien soumettre ni envoyer ;
- n'utiliser aucune commande git qui change l'état, sauf le chef d'orchestre ;
- inclure dans toute requête externe aucun détail personnel du candidat.

Le **chef d'orchestre** n'est pas un agent : c'est la session principale de la routine. Il enchaîne les agents, applique les plafonds, synchronise le tableau de bord, commit et pousse `career-data`, et notifie.

### 6.2 La routine quotidienne

- **Déclenchement** : une tâche programmée claude.ai, avec une nouvelle session à chaque fois, dans l'environnement cloud actuel avec les deux dépôts. Heure : **7 h 40, heure de Paris** *(choix de Claude ; en dehors des heures chargées)*. Connecteurs : Microsoft 365, Firecrawl, Indeed.
- **Instruction** : exécuter la procédure « routine quotidienne » décrite dans `modes/_custom.md` du candidat. Le candidat peut ainsi la relire et la modifier sans toucher au dépôt public.
- **Étapes, dans l'ordre :**
  1. vérifications : `node doctor.mjs --json`, sans mise à jour en mode non surveillé ;
  2. synchronisation du tableau de bord, étape 1 : appliquer les demandes de la page (refus, confirmations de statut, notes) ;
  3. Suivi ;
  4. Éclaireur ;
  5. Évaluateur, **au plus 8 nouvelles offres par jour** *(choix de Claude)* ;
  6. Expert CV et lettre, **au plus 3 dossiers par jour** *(choix de Claude ; qualité plutôt que volume)*, sur les offres ≥ 4,0 encore en ligne et sans signal de légitimité « suspect » ;
  7. Coach entretien, pour chaque nouvelle candidature en `Interview` ;
  8. synchronisation du tableau de bord, étape 2 : export de l'instantané ;
  9. commit et push de `career-data` ;
  10. notification iPhone **seulement si une action est attendue**, par exemple « 2 candidatures prêtes, 1 statut à confirmer », ou en cas d'échec avec la raison.
- **Échec d'une étape** : les étapes suivantes qui n'en dépendent pas continuent, et la notification d'échec dit ce qui manque.

### 6.3 La fiche stratégie (espace CV)

Écrite par l'Expert CV et lettre pour chaque dossier préparé, dans `{DATA_ROOT}/output/{num}-{entreprise}-strategie.json`. Champs :

- `titre_cv` : le titre affiché sous le nom ;
- `angle` : une à deux phrases, l'histoire racontée au recruteur ;
- `preuves` : les éléments mis en avant, chacun avec sa source (par exemple « cv.md › expérience la plus récente ») ;
- `mots_cles_repris` : les mots de l'annonce effectivement présents dans le CV ;
- `mots_cles_ecartes` : chaque mot avec sa raison (« aucune expérience correspondante dans cv.md ») ;
- `ecarts` : chaque exigence de l'annonce non couverte, avec la façon dont la lettre la traite, ou « non abordée » ;
- `lettre_angle` : une phrase ;
- `verification` : résultat des contrôles ci-dessous.

**Contrôle de cohérence** : un nouveau script `extensions/` vérifie que `titre_cv` est bien le titre du CV généré et que chaque `mots_cles_repris` apparaît dans le texte du PDF. En cas d'échec, l'Expert corrige le CV ou la fiche, puis relance.

### 6.4 Tableau de bord

- **« Prête à envoyer »** : sans nouveau statut. Un dossier préparé est enregistré dans `data/dashboard.json` (ajout à `cv_assets` : lettre, message, réponses, fiche). L'instantané en tire un indicateur « Prête ». La candidature reste `Evaluated` jusqu'à `Applied`.
- **Fiche candidature, section « Espace CV »**, dans cet ordre :
  1. le résumé de stratégie (titre, angle, preuves, mots-clés repris et écartés, écarts) ;
  2. « Voir le CV » (existe) et « Voir la lettre » (même visionneuse) ;
  3. « Télécharger le CV (PDF) » et « Télécharger la lettre (PDF) », avec la capacité `downloads` : la page lit `/_blob/<id>` puis appelle `downloads.save`, et prévient si le navigateur refuse ;
  4. le message au recruteur, avec un bouton Copier ;
  5. « Refuser cette offre », une demande `Discarded` appliquée par `set-status.mjs`.
- **Accueil** : une liste « À envoyer » (dossiers prêts) et une liste « À confirmer » (propositions de statut du Suivi, avec Confirmer ou Ignorer, chacune une demande).
- **Relances dues** : le texte proposé, avec un bouton Copier.
- **Capacités** : ajouter `downloads: true` à la déclaration actuelle (db, mcp, assets) : déclarer d'abord, publier ensuite.

### 6.5 La commande « postule » sur le Mac

- **Installation, une fois**, guidée par Claude dans une session locale sur le Mac :
  - outils : Node (LTS) et git ;
  - clones côte à côte des deux dépôts, avec le marqueur `.career-ops-data` ;
  - `npm install` ;
  - `npx playwright install chromium` (sur le Mac ; c'est l'environnement cloud qui ne doit pas réinstaller Playwright) ;
  - authentification GitHub pour le dépôt privé.
- **Commande** : le candidat ouvre l'application Claude, onglet Code, sur le dossier career-ops, et dit « postule ». C'est une procédure de `modes/_custom.md` qui appelle l'agent Candidature.
- **Déroulé** :
  1. `git pull` de `career-data` ;
  2. liste des dossiers prêts, du plus ancien au plus récent ;
  3. pour chacun :
     - ouvrir l'URL canonique (celle de l'employeur quand elle a été confirmée) dans la fenêtre visible ;
     - si une connexion est demandée, attendre que le candidat se connecte ;
     - remplir le formulaire avec les fichiers et réponses du dossier ;
     - montrer les réponses générées pour des questions imprévues ;
     - **s'arrêter** ;
     - demander au candidat s'il a envoyé : oui, alors `set-status.mjs … Applied` ; non, ou plus tard, alors rien ;
  4. commit et push de `career-data`, puis synchronisation du tableau de bord.
- **Site qui refuse le remplissage** : l'agent présente la liste numérotée des réponses et les fichiers à joindre, pour le navigateur habituel.

### 6.6 Suivi et propositions de statut

- **Lecture** des e-mails récents par le connecteur, en lecture seule. Classement selon `reply-watch` (Interview, Responded, Rejected, Offer, Need Action…) et rattachement aux lignes du tracker.
- **Propositions** : chaque proposition devient un document de la base du tableau de bord, avec l'e-mail en preuve (expéditeur, date, objet, extrait court). Le candidat confirme : une demande de statut existante, appliquée à la routine suivante ou dans la session en cours. S'il ignore la proposition, elle est retirée.
- **Relances** : calculées par `followup` avec la cadence par défaut. Texte rédigé selon les règles d'écriture du candidat.

### 6.7 Notifications

- Notification push de fin de tâche programmée (option des tâches programmées), seulement quand une action est attendue ou en cas d'échec.
- **À vérifier par le constructeur** : comment une session programmée notifie l'iPhone (option de la tâche, outil de notification, ou les deux).

### 6.8 Tests et vérification

- **Tests unitaires** (`node --test`) pour tout nouveau script : contrôle de cohérence de la fiche, champs ajoutés à l'instantané, demandes « refuser » et « confirmer ».
- **Tests de page** (harnais existant) pour l'espace CV :
  - résumé échappé ;
  - téléchargements avec faux `downloads`, y compris le refus ;
  - listes « À envoyer » et « À confirmer » ;
  - 360 et 430 px.
- **Données fictives** (« Camille Test ») pour tous les tests. Jamais `export.mjs` ni `apply-requests.mjs` sur la vraie racine de données pendant un test.
- **Première routine** lancée à la main, devant le candidat, avant de programmer la tâche.
- **Première « postule »** sur un vrai dossier, devant le candidat.

## 7. Ce qui reste au constructeur

- Noms exacts des fichiers et des fonctions, et rédaction des consignes de chaque agent, dans le respect de 6.1.
- Modèle et effort de chaque agent. Suggestion : le modèle le plus capable pour l'Expert CV et lettre ; un modèle plus léger acceptable pour l'Éclaireur.
- Format exact des documents de la base pour les propositions et les dossiers prêts, dans la logique de `requests` et `snapshot` existants.
- Réglage des plafonds après une semaine d'usage.

## 8. Risques et inconnues

- **Coût** : une session quotidienne avec plusieurs agents consomme le forfait. Les plafonds le bornent ; à surveiller la première semaine.
- **Sites qui bloquent l'automatisation** (connexion, captcha, détection) : la liste à coller est prévue, sans contournement.
- **Écritures concurrentes** dans `career-data` (routine cloud et session Mac) : `git pull` avant, petits commits, et en cas de conflit, arrêt avec un message plutôt que fusion forcée.
- **Mises à jour de career-ops** qui renommeraient un mode cité par un agent : les agents citent les modes par nom, à revoir à chaque mise à jour.
- **Notification depuis une session programmée** : mécanisme à confirmer (6.7).
