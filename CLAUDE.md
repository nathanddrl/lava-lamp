# Lava Lamp — simulateur 3D dans le navigateur

## Vision

Simuler une vraie lampe à lave, dans le navigateur, à **60 fps sur un laptop correct**.

- **Cire = quelques centaines de particules** avec une physique simplifiée : cohésion
  (attraction à courte portée), température (chauffée par l'ampoule en bas, refroidie
  en haut), flottabilité (densité dépendante de la température), viscosité / amortissement.
- **Rendu = surface lisse** obtenue par **raymarching d'un champ de densité** (metaballs)
  construit à partir des particules, dans un fragment shader limité au volume du verre.
- Comportements visés : colonne qui s'étire, étranglement, détachement de gouttes,
  fusion des gouttes entre elles, accumulation en haut puis redescente.

## Stack

Vite + TypeScript strict + Three.js (WebGL2) + lil-gui (debug uniquement).
Pas de framework UI, pas de moteur physique externe.

```
npm run dev        # serveur de dev
npm run build      # typecheck (tsc --noEmit) + build Vite
npm run typecheck
npm test           # vitest (src/**/*.test.ts)
npm run bench -- [--preset calme] [--seconds 600] [--set clé=valeur ...] [--summary] [--sections 10]
                   # banc headless : répartition, suivi des gouttes, verdicts (+ coupes ASCII)
```

## Architecture

```
src/
  sim/      Physique pure. AUCUN import de three ni du DOM.
    lampProfile.ts       Profil de révolution unique (socle, verre, capuchon) + innerRadius(y).
    simulation.ts        Orchestration : step(dt) à pas fixe, reset, impulse.
    waxSystem.ts         Cire : particules en TypedArrays, solveur Clavet 2005.
    spatialHashGrid.ts   Grille de hachage spatial uniforme (voisinage).
    presets.ts           SIM_FIXED_DT + presets thermiques (équilibré, calme, agité).
    random.ts            PRNG seedé (mulberry32).
    *.test.ts            Tests vitest (grille vs force brute, stabilité de la cire).
  render/   Tout ce qui touche Three.js : scène, caméra, matériaux, shaders.
    lamp.ts          LatheGeometry des 3 pièces générées depuis LampProfile.
    stage.ts         Renderer, scène, OrbitControls bornés, lumières, sol, resize.
    waxDebugView.ts  InstancedMesh de sphères (debug), interpolé entre deux pas fixes.
  ui/       Panneau lil-gui (debug). Ne contient pas de logique métier.
  main.ts   Assemblage + boucle (accumulateur à pas fixe).
scripts/
  bench.ts  Banc headless (tsx) : répartition par hauteur, suivi individuel des gouttes
            (taille, hauteur max, fusions en vol, départs), ligne OBJECTIFS en fin de run.
```

Sens des dépendances : `main → render → sim`, `main → ui`, `main → sim`. Jamais `sim → render/ui`.

### Profil de la lampe (source de vérité géométrique)

`LampProfile` (src/sim/lampProfile.ts) définit toute la géométrie à partir de
`LampDimensions` :
- `baseProfile()`, `glassProfile()`, `capProfile()` → points `{r, y}` pour les Lathe.
- `innerRadius(y)` → rayon intérieur du récipient (0 hors de `[yMin, yMax]`) ;
  c'est ce que la physique utilise pour les collisions avec la paroi.
- Le verre est une courbe cubique monotone (Fritsch–Carlson) sur des points de
  contrôle : C1, sans dépassement.
- La physique ne doit dépendre que de l'interface `ContainerShape`
  (`yMin`, `yMax`, `innerRadius`).

Unités : **1 unité = 10 cm**, Y vers le haut, sol en y = 0, axe de la lampe en x = z = 0.

### Boucle (src/main.ts)

- Physique à **pas fixe** `SIM_FIXED_DT = 1/60 s` (× 2 sous-pas) via un accumulateur, découplé
  du framerate. 1/120 coûtait ~7 ms/frame à 800 particules ; à 1/60, ~3 ms et c'est stable.
- `frameDt` borné à 0.1 s (onglet suspendu), au plus 12 steps par frame ; au-delà on
  jette le retard (pas de spirale de la mort).
- `sim.params.timeScale` (0 à ×10) et `sim.params.paused` agissent sur l'accumulateur. À
  ~3 ms/pas, ×10 demande ~30 ms de physique par frame : le compteur « vitesse réelle »
  du panneau affiche la vitesse effectivement atteinte.
- `stage.render(alpha)` reçoit `alpha = accumulator / FIXED_DT` pour interpoler
  l'état entre deux steps (à exploiter quand les particules existent).

### Cire (src/sim/waxSystem.ts)

Clavet, Beaudoin & Poulin 2005, « Particle-based Viscoelastic Fluid Simulation ».
Par sous-pas (2 par pas fixe → dt = 1/120 s) :
gravité + traînée linéaire → voisinage (grille) → viscosité par impulsions radiales
(paires i<j qui se rapprochent, impulsion bornée à la vitesse relative) → prédiction
→ double density relaxation (Gauss-Seidel) → collisions (fond, plafond, paroi
`innerRadius(y)` avec normale tenant compte de la pente, friction de Coulomb) → v = Δx/dt.

Mise à l'échelle 400 → 800 particules à volume constant : h ∝ N^(−1/3) (0.13 → 0.103),
k et k near × 0.8, rayon de collision et taille des sphères idem.

Leçons du réglage mécanique :
- `k` élevé (≥ 100 avec ρ0 = 7) → la masse « bout » : le déplacement est en dt²·k·Δρ
  sommé sur ~N voisins, il doit rester petit devant h.
- Une friction appliquée comme facteur par sous-pas colle les particules au verre ;
  la friction de Coulomb (∝ vitesse normale annulée) est indépendante du dt.
- L'impulsion doit avoir un gradient (haut et cœur rapides, base posée), sinon le bloc
  décolle entier sans s'étirer.

### Thermique (étapes 3 et 3 bis)

T ∈ [0, 1] par particule :

    dT/dt = chauffe(y, r)·(1 − T) + échange(y, r)·exposition·(T_amb(y) − T) + conduction

- **Chauffe** : point chaud gaussien mince et étroit au centre du fond (falloff 0.03,
  rayon 0.05) → seule une petite fraction du réservoir fond à la fois, colonne étroite.
- **Ambiance stratifiée T_amb(y)** : 0.2 au fond (sous la bande morte → le réservoir reste
  figé), 0.5 sur toute la zone médiane (au centre de la bande morte → une goutte ne change
  jamais d'état en route), 0.05 sous le capuchon à partir de 90 % de la hauteur.
- **Échange** avec le liquide : taux × (1 + boost haut + boost paroi), atténué au cœur des
  blobs (exposition estimée par la densité locale).
- **Flottabilité** ∝ (T − Tn) avec **hystérésis de fusion** (δ = 0.3) : Tn − δ/2 pour une
  particule fondue, Tn + δ/2 pour une figée (bascule de Schmitt).
- **Viscosité thermique** : σ et β × 0.05 pour la cire fondue (interpolé sur la bande).
- **Chaleur latente** (`meltDelay` 2.5 s) : une particule figée doit rester 2.5 s au-dessus
  de Tn + δ/2 avant de fondre. Sans elle, la cire voisine d'une colonne déjà formée garde le
  point chaud chaud, qui refond en continu tout ce qu'on lui amène : **fontaine permanente**
  réservoir → capuchon (régime « jet »). Avec, la colonne se tarit et le point chaud lâche
  des paquets (régime « goutte à goutte »).

Pourquoi chaque ingrédient existe — **ne rien retirer sans repasser au banc** :
1. Forces faibles → tout reste figé (le fluide de Clavet a un seuil d'écoulement). Il faut
   des forces fortes (buoyancy 60) et une traînée forte (60).
2. Taux thermiques rapides sans stratification → strates immobiles ; chauffe qui décroît
   en douceur → « boule qui flotte » à l'équilibre chauffe = refroidissement.
3. Sans hystérésis : convection stationnaire ou réservoir posé à T = Tn. L'hystérésis
   crée l'oscillateur de relaxation.
4. Étape 3 (refroidissement vers 0 partout) : les têtes se refigeaient vers 60–75 % de la
   hauteur. L'ambiance médiane dans la bande morte les laisse monter jusqu'au capuchon.
   Piège : une ambiance de fond dans la bande morte (0.6) laisse tout le réservoir fondu
   → il monte d'un bloc. Le fond doit être sous Tn − δ/2.
5. Avec ambiance stratifiée mais chauffe large : une tige continue relie réservoir et
   capuchon (fontaine), le réservoir se vide. La chauffe localisée tarit l'alimentation.
6. Calotte suspendue sous le capuchon (cœur protégé, encore fondu) qui accumule les
   arrivées : échange haut ×30 et `interiorCooling` 0.4.
7. Ablation (10 min) : sans ambiance → figé ; sans chauffe localisée → réservoir effondré,
   amas de 800 ; sans viscosité thermique **avec** échange paroi → gouttes trop grosses
   (médiane 120–145) ; l'échange paroi (10) double la fréquence des gouttes. Les deux
   derniers ne valent qu'ensemble.

8. Fontaine permanente (signalée à l'œil, invisible des premières métriques du banc qui ne
   comptaient que les gouttes) : 62 % du temps en équilibré, 88 % en agité. Corrigée par
   la chaleur latente. Le banc mesure désormais la part du temps où le réservoir est relié
   sans rupture à la cire au-dessus de 80 % (objectif ≤ 25 %, jamais ≥ 30 s d'affilée).
   Régime jet ↔ goutte à goutte très tranché : plus de chauffe, plus de traînée, un point
   chaud plus large ou un délai de fusion plus court ramènent le jet ; un délai plus long
   (≥ 3 s) donne des gouttes trop petites.

Comportement observé : des paquets fondent au point chaud, montent en colonne courte ou en
goutte, se détachent, s'aplatissent sous le capuchon, refroidissent et redescendent. Le
seuil de démarrage est abrupt : chauffe < ~3.5 → le point chaud ne fond plus.

Résultats au banc (10 min simulées, après 60 s de mise en route, graine 1) :

| preset    | réservoir min/moy | gouttes/min | taille méd. naissance (max) | 40–150 | têtes ≥ 90 % | colonne (plus longue) |
|-----------|-------------------|-------------|-----------------------------|--------|--------------|-----------------------|
| équilibré | 78 % / 82 %       | 10.2        | 54 (171)                    | 55 %   | 60 %         | 13 % (19 s)           |
| calme     | 76 % / 82 %       | 5.7         | 69 (175)                    | 57 %*  | 79 %         | 15 % (13 s)           |
| agité     | 82 % / 85 %       | 17.9        | 33 (145)                    | 40 %   | 38 %         | 3 % (4 s)             |

\* à la naissance ; en taille max (fusions en vol comprises) le calme passe sous 50 %.
Équilibré sur 4 graines : tous les objectifs tenus à chaque fois (colonne 13–18 %).
Aucun preset ne s'arrête ni ne reste collé en haut sur 10 min.

Coût mesuré : ~3 ms CPU par pas fixe (800 particules), 1 pas par frame à 60 fps.

## Conventions

- TypeScript strict (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` → `import type` pour les imports de types).
- `src/sim` : pas d'allocation dans `step()` (buffers typés `Float32Array` réutilisés,
  layout SoA), déterministe à pas fixe, pas de `Math.random` non seedé dans la boucle.
- Données sim → rendu via des buffers typés (upload en texture / uniform), pas d'objets Three dans sim.
- Shaders GLSL dans `src/render/shaders/*.glsl` (import `?raw`), WebGL2 / GLSL ES 3.00.
- Tout paramètre réglable passe par un objet `params` exposé dans le panneau lil-gui.
- Commentaires et UI en français, identifiants en anglais.
- Toujours vérifier : `npm run build` passe, aucune erreur console sous `npm run dev`.

## Feuille de route

1. ✅ Fondations : projet, profil de lampe, scène, contrôles, boucle à pas fixe.
2. ✅ Particules Clavet 2005 : cohésion, viscosité, collisions, grille spatiale, rendu debug.
3. ✅ Thermique : cycle chauffe/montée/refroidissement/descente, presets, banc headless.
   ✅ 3 bis : ambiance stratifiée, chauffe localisée, viscosité thermique (gouttes 40–150, têtes > 90 %).
   ✅ 3 ter : chaleur latente contre la fontaine permanente ; vitesse jusqu'à ×10.
4. Rendu raymarching du champ de densité dans le volume du verre (bornage par le profil).
5. Matériaux : verre réfractif, liquide teinté, cire émissive/subsurface, glow de l'ampoule.
6. Perf : profiling, résolution du raymarch adaptative, budget 60 fps.
