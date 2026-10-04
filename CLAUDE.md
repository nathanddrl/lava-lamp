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
npm run bench -- [--preset calme] [--seconds 300] [--set clé=valeur ...] [--sections 10]
                   # banc headless : métriques du cycle thermique (+ coupes ASCII)
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
  bench.ts  Banc headless (tsx) : répartition par hauteur, amas, vitesses, trajets.
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
- `frameDt` borné à 0.1 s (onglet suspendu), au plus 8 steps par frame ; au-delà on
  jette le retard (pas de spirale de la mort).
- `sim.params.timeScale` et `sim.params.paused` agissent sur l'accumulateur.
- `stage.render(alpha)` reçoit `alpha = accumulator / FIXED_DT` pour interpoler
  l'état entre deux steps (à exploiter quand les particules existent).

### Cire (src/sim/waxSystem.ts)

Clavet, Beaudoin & Poulin 2005, « Particle-based Viscoelastic Fluid Simulation ».
Par sous-pas (2 par pas fixe → dt = 1/240 s) :
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

### Thermique (étape 3)

T ∈ [0, 1] par particule. Chauffe gaussienne au centre du fond (contact seulement),
refroidissement fort en haut (profil hauteur^8) et contre le verre, atténué au cœur des
blobs (exposition estimée par la densité), conduction entre voisins sur les paires de la
viscosité. Flottabilité ∝ (T − Tn), avec **hystérésis de fusion** : Tn − δ/2 pour une
particule fondue, Tn + δ/2 pour une figée.

Démarche (≈ 60 configurations au banc, voir `npm run bench`) et pourquoi chaque ingrédient
existe — **ne pas les retirer sans repasser au banc** :
1. Forces faibles (flottabilité ~1) → tout reste figé : le fluide de Clavet a un seuil
   d'écoulement. Il faut des forces fortes (buoyancy 40) **et** une traînée forte (60)
   pour garder ~0.1 u/s.
2. Taux thermiques ~1/s → chaque particule prend la température d'équilibre de sa
   hauteur → strates immobiles. Il faut de l'inertie thermique (refroidissement
   ~0.01/s hors du haut) pour qu'une goutte garde sa chaleur pendant la montée.
3. Chauffe qui décroît en douceur avec la hauteur → attracteur « boule qui flotte » à
   l'altitude où chauffe = refroidissement. Chauffe au contact seulement (falloff 0.06).
4. Même ainsi, sans hystérésis : convection stationnaire (pilier immobile) ou réservoir
   posé à T = Tn. L'hystérésis de fusion (δ = 0.3) transforme ça en oscillateur de
   relaxation : c'est elle qui crée le cycle.
5. Cohésion pleine (1) → la tige aspire tout le réservoir et la masse monte d'un bloc.
   cohesion = 0.5 laisse les gouttes se détacher.

Résultats au banc (5 min simulées, graine 1) :

| preset    | réservoir (bas 20 %) min / moy | montée médiane | stagnation / collé en haut |
|-----------|--------------------------------|----------------|----------------------------|
| équilibré | 37 % / 58 %                    | 17 s           | 0 / 0                      |
| calme     | 46 % / 78 %                    | (rare > 75 %)  | 0 / 0                      |
| agité     | 39 % / 57 %                    | 7 s            | 0 / 0                      |

Limites connues : les gouttes détachées sont souvent grosses (~400 particules, la moitié
de la cire) avec quelques petites (10–40) ; les têtes s'aplatissent vers 65–75 % de la
hauteur plutôt que sous le capuchon.

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
4. Rendu raymarching du champ de densité dans le volume du verre (bornage par le profil).
5. Matériaux : verre réfractif, liquide teinté, cire émissive/subsurface, glow de l'ampoule.
6. Perf : profiling, résolution du raymarch adaptative, budget 60 fps.
