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
```

## Architecture

```
src/
  sim/      Physique pure. AUCUN import de three ni du DOM.
    lampProfile.ts   Profil de révolution unique (socle, verre, capuchon) + innerRadius(y).
    simulation.ts    Simulation (step(dt) à pas fixe). Les particules viendront ici.
  render/   Tout ce qui touche Three.js : scène, caméra, matériaux, shaders.
    lamp.ts          LatheGeometry des 3 pièces générées depuis LampProfile.
    stage.ts         Renderer, scène, OrbitControls bornés, lumières, sol, resize.
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
2. Particules : intégration, collisions avec `innerRadius(y)`, gravité/flottabilité, température.
3. Cohésion / viscosité (voisinage via grille spatiale), réglage des comportements.
4. Rendu raymarching du champ de densité dans le volume du verre (bornage par le profil).
5. Matériaux : verre réfractif, liquide teinté, cire émissive/subsurface, glow de l'ampoule.
6. Perf : profiling, résolution du raymarch adaptative, budget 60 fps.
