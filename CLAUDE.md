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
```

## Architecture

```
src/
  sim/      Physique pure. AUCUN import de three ni du DOM.
    lampProfile.ts       Profil de révolution unique (socle, verre, capuchon) + innerRadius(y).
    simulation.ts        Orchestration : step(dt) à pas fixe, reset, impulse.
    waxSystem.ts         Cire : particules en TypedArrays, solveur Clavet 2005.
    spatialHashGrid.ts   Grille de hachage spatial uniforme (voisinage).
    random.ts            PRNG seedé (mulberry32).
    *.test.ts            Tests vitest (grille vs force brute, stabilité de la cire).
  render/   Tout ce qui touche Three.js : scène, caméra, matériaux, shaders.
    lamp.ts          LatheGeometry des 3 pièces générées depuis LampProfile.
    stage.ts         Renderer, scène, OrbitControls bornés, lumières, sol, resize.
    waxDebugView.ts  InstancedMesh de sphères (debug), interpolé entre deux pas fixes.
  ui/       Panneau lil-gui (debug). Ne contient pas de logique métier.
  main.ts   Assemblage + boucle (accumulateur à pas fixe).
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

- Physique à **pas fixe** `FIXED_DT = 1/120 s` via un accumulateur, découplé du framerate.
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

Réglages par défaut (validés par `waxSystem.test.ts`) : h = 0.13, ρ0 = 3 (~30 voisins),
k = 40, k near = 160, σ = 60, β = 20, gravité apparente 0.8, traînée 0.6, μ = 0.3.
Leçons du réglage :
- `k` élevé (≥ 100 avec ρ0 = 7) → la masse « bout » en permanence : le déplacement est
  en dt²·k·Δρ sommé sur ~N voisins, il doit rester petit devant h.
- Une friction appliquée comme facteur par sous-pas colle les particules au verre ;
  la friction de Coulomb (∝ vitesse normale annulée) est indépendante du dt.
- L'impulsion doit avoir un gradient (haut et cœur rapides, base posée), sinon le bloc
  décolle entier sans s'étirer. Hauteur de référence = moyenne + 1.5σ (robuste aux isolées).

Coût mesuré : ~1.5–1.9 ms CPU par pas fixe pour 400 particules (2 pas par frame à 60 fps).

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
3. Thermique : chauffe par l'ampoule, refroidissement en haut, flottabilité fonction de T.
4. Rendu raymarching du champ de densité dans le volume du verre (bornage par le profil).
5. Matériaux : verre réfractif, liquide teinté, cire émissive/subsurface, glow de l'ampoule.
6. Perf : profiling, résolution du raymarch adaptative, budget 60 fps.
