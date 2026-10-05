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
npm run bench:splat -- [--hz 60] [--jitter 0.3] [--resolution 48] [--kernel 0.085]
                   # banc du champ de densité : coût CPU, scintillement, occupation
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
    lamp.ts          Socle, capuchon (métal + PMREM), verre physique en deux passes.
    stage.ts         Renderer (test WebGL2), pièce sombre, PMREM, lumières, sol, cadrage,
                     thème courant, qualité appliquée, chronos.
    densityField.ts  Splatting CPU des particules en grille 3D (pur TS, sans three, testé).
    waxSurfaceView.ts  Texture 3D du champ + volume raymarché unique (cire + liquide).
    halo.ts          Halo coloré additif posé sur le sol.
    postprocess.ts   EffectComposer : HDR MSAA → bloom → OutputPass (ACES) → finition.
    themes.ts        5 palettes + ThemeBlender (transition en espace linéaire).
    quality.ts       Qualité adaptative (logique pure, testée).
    gpuTimer.ts      Temps GPU de la frame (EXT_disjoint_timer_query_webgl2).
    waxDebugView.ts  InstancedMesh de sphères (debug, désactivé par défaut).
    shaders/         volume.vert/.frag + volumeCommon, halo, finish (vignette, grain).
  ui/       controlBar (interface finale + message d'erreur), debugPanel (lil-gui, touche D).
            Aucune logique métier.
  main.ts   Assemblage + boucle (accumulateur à pas fixe).
scripts/
  bench.ts       Banc headless (tsx) : répartition par hauteur, suivi individuel des gouttes
                 (taille, hauteur max, fusions en vol, départs), ligne OBJECTIFS en fin de run.
  splatBench.ts  Banc du champ de densité (coût, allers-retours au seuil, occupation).
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
- `alpha = accumulator / FIXED_DT` : le splatting interpole les positions entre les
  deux derniers pas fixes.
- `stage.render(wax, alpha, frameDt, time)` : `time` anime le grain.
- En dev, `window.lava = { sim, stage, stats, state }` (console, captures automatisées).
- Tout le reste de main.ts vit dans `run(stage)` : sans WebGL2, rien ne démarre et
  aucune erreur non rattrapée n'arrive en console.

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

- **Chauffe** : point chaud gaussien mince et étroit au centre du fond (taux 3.3, falloff 0.03,
  rayon 0.065) → seule une petite fraction du réservoir fond à la fois, colonne étroite.
- **Ambiance stratifiée T_amb(y)** : 0.2 au fond (sous la bande morte → le réservoir reste
  figé), 0.5 sur toute la zone médiane (au centre de la bande morte → une goutte ne change
  jamais d'état en route), 0.24 sous le capuchon à partir de 90 % de la hauteur.
- **Échange** avec le liquide : taux × (1 + boost haut + boost paroi), atténué au cœur des
  blobs (exposition estimée par la densité locale).
- **Flottabilité** ∝ (T − Tn) avec **hystérésis de fusion** (δ = 0.3) : Tn − δ/2 pour une
  particule fondue, Tn + δ/2 pour une figée (bascule de Schmitt).
- **Viscosité thermique** : σ et β × 0.05 pour la cire fondue (interpolé sur la bande).
- **Chaleur latente** (`meltDelay` 2.75 s) : une particule figée doit rester 2.75 s au-dessus
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

9. Réglage final (chauffe 3.3, rayon 0.065, délai 2.75 s, ambiance haute 0.24) : compromis
   entre le réglage précédent (chauffe 4, gouttes médiane ~55, colonne 13 %, jusqu'à 19 s)
   et un essai manuel (chauffe 3, ambiance haute 0.24 : colonne 0 % mais gouttes médiane ~21).
   Plus de chauffe, un point chaud plus large ou un délai plus court grossissent les gouttes
   **et** ramènent la colonne ; c'est le couplage central du modèle.

Comportement observé : des paquets fondent au point chaud, montent en colonne courte ou en
goutte, se détachent, s'aplatissent sous le capuchon, refroidissent et redescendent. Avec la
chaleur latente, une chauffe de 3 suffit encore à faire fondre le point chaud (l'ancien seuil
« ~4 » datait d'avant `meltDelay`).

Résultats au banc (10 min simulées, après 60 s de mise en route) :

| preset    | réservoir min/moy | gouttes/min | taille méd. naissance (max) | 40–150 | têtes ≥ 90 % | colonne (plus longue) |
|-----------|-------------------|-------------|-----------------------------|--------|--------------|-----------------------|
| équilibré | 78 % / 82 %       | 10.2        | 40 (55)                     | 49 %*  | 54 %         | 9 % (7 s)             |
| calme     | 73 % / 81 %       | 4.7         | 68 (95)                     | 50 %   | 86 %         | 20 % (21 s)           |
| agité     | 80 % / 84 %       | 18.6        | 32 (35)                     | 38 %   | 34 %         | 1 % (1 s)             |

\* 40–150 majoritaire en taille max. Équilibré sur 3 graines : colonne 4–9 % (≤ 7 s),
médiane 44–55, têtes ≥ 90 % entre 44 et 54 %. Aucun preset ne s'arrête ni ne reste collé
en haut sur 10 min.

Coût mesuré : ~3 ms CPU par pas fixe (800 particules), 1 pas par frame à 60 fps.

### Rendu de la cire (étape 4)

Pipeline par frame : splatting CPU → upload texture 3D → raymarch dans le verre.

- **Champ** (`DensityField`) : grille alignée sur le récipient, voxels cubiques
  (48 × 94 × 48 par défaut, voxel ≈ 0.025), marge d'1.5 voxel. Noyau séparable à support
  compact k(u) = (1 − u²)³ par axe (rayon 0.085) : 3 petits tableaux de poids par particule.
  Normalisé par la densité de cœur d'une cire de Clavet au repos (ρ0 / (2π/15 · h³)) :
  **le champ vaut ≈ 1 dans la masse** (médiane 0.89 aux particules), 0.5 en surface,
  ≈ 0.33 au centre d'une particule isolée (invisible au seuil 0.5 : pas de poussière).
  Canaux RG entrelacés : densité, température × densité. Upload en `RG32F` si
  `OES_texture_float_linear`, sinon `RG16F` (conversion par le pilote).
- **Lissage temporel** : champ ← keep·champ + (1 − keep)·splat, keep = exp(−dt/τ), τ = 0.04 s,
  appliqué en place (pas de second tampon). Lignes inactives remises à zéro puis ignorées.
  Mesure : 0.00 % de voxels de surface en aller-retour au seuil, même sans lissage
  (l'interpolation alpha suffit) ; le lissage efface le résidu (0.02 % max à 60 Hz ± 30 %).
- **Occupation** : blocs de 4³ voxels marqués par l'empreinte (dilatée d'un voxel) des
  particules, persistants tant que la contribution n'a pas décru sous 2 %. Le raymarch
  saute les blocs vides d'un coup : ~17 % des blocs occupés, **3× moins de lectures**
  de texture (1080p, lampe plein écran : 46 M au lieu de 138 M par frame).
- **Raymarch** (`volume.frag.glsl`, voir étape 5 pour la passe) : segment = de la face
  d'entrée à la sortie de la boîte du liquide, le long du rayon réfracté. Pas uniforme
  (≥ ½ voxel), bissection (6) au franchissement du seuil, normale = −∇ (différences
  centrales sur 1 voxel ; le tricubique B-spline a été essayé : identique à l'œil, 8× plus
  cher). Densité × masque du verre (LUT du rayon intérieur) : la cire s'aplatit contre la
  paroi au lieu de la traverser. Écrit `gl_FragDepth`.
- **Shading** : wrap lighting (clé, contre-jour, ampoule), spéculaire large et faible,
  fresnel doux vers la lumière du liquide, faux subsurface = lumière de l'ampoule × exp(−
  épaisseur le long du rayon), émission selon la température et la proximité du fond.
  Épaisseur : 10 échantillons à pas croissants, poids continu en densité (un poids
  binaire dessinait des paliers horizontaux sur le réservoir).
- **Liquide** : intégré dans la même boucle (émission-absorption), voir étape 5.
- Mesures (Xeon 2.1 GHz, Node/V8) : splatting **1.1–1.25 ms médian, p95 ~1.3–1.9 ms**
  (800 particules, 48³ × 2). Temps GPU : compteur « rendu GPU » du panneau (timer query) ;
  non mesurable ici (rendu logiciel SwiftShader).

### Finition (étape 5)

- **Une seule passe de volume** (`waxSurfaceView` + `volume.frag.glsl`) : faces **avant**
  du volume intérieur fermé. Le rayon est réfracté à l'entrée (`refract`, ior du liquide
  1.38 ; la paroi mince ne dévie pas en net), puis raymarché. Cire touchée → opaque +
  `gl_FragDepth` au point touché ; sinon liquide seul, prémultiplié, profondeur de la face
  d'entrée. Matériau transparent `renderOrder 2`, `depthWrite` actif.
- **Pas de `transmission` sur le verre** : Three.js re-rend tous les opaques dans une
  cible MSAA séparée pour la transmission (WebGLRenderer.renderTransmissionPass), donc
  le raymarch serait calculé deux fois. Le verre est un `MeshPhysicalMaterial` noir,
  additif, sans transmission : il n'apporte que la réflexion (PMREM de `RoomEnvironment`,
  fresnel, ior 1.5, clearcoat). Deux meshes : face arrière (`renderOrder 1`, reflets ×0.5)
  avant le volume, face avant (`renderOrder 3`) après.
- **Liquide** : absorption (teinte de ce qu'on voit à travers) et diffusion (`liquidGlow`,
  à quel point il s'illumine) **séparées**. Liées, un liquide jaune n'absorbe presque pas
  le rouge et restait sombre et olive.
- **Ampoule** : uniforms `uBulb*` (lueur du liquide décroissant avec la hauteur, subsurface,
  émission de la cire) × `power`. La `PointLight` est **sous le col du socle** : placée
  dans le verre, elle laissait un reflet ponctuel blanc sur le verre. Falloff de la cire
  en 1/(1 + 10 d²) : en 1/(1 + 4 d²), le point chaud brûlait en blanc.
- **Pièce sombre** : fond #030204, `environmentIntensity` 0.12, appoint faible (`room`).
  Halo au sol : disque additif (pied lumineux + nappe gaussienne), couleur du thème.
- **Post-process** : cible HalfFloat MSAA (le renderer n'a pas d'antialias) → UnrealBloom
  (seuil 0.75 en linéaire : seul l'émissif dépasse) → OutputPass (ACES + sRGB) → vignette
  et grain en espace d'affichage (`finish.frag.glsl`). Les `#include <tonemapping_fragment>`
  des ShaderMaterial sont neutres dans une cible : le tone mapping n'est fait qu'une fois.
- **Thèmes** : classique, océan, néon, absinthe, crépuscule. `ThemeBlender` interpole en
  linéaire (smoothstep, 1.6 s) et n'écrit dans les params que pendant une transition : le
  panneau reste libre le reste du temps.
- **Allumage** (main.ts) : `sim.reset('settled')` (couches tassées au fond, froides),
  puissance 0 → 1 en 2.5 s, vitesse ×1 → ×8 → ×1 sur 7 s réelles (~45 s simulées, le
  temps que le point chaud fonde : premières montées vers 40–60 s simulées). La qualité
  adaptative est suspendue pendant l'allumage (la physique accélérée fausse la mesure).
- **Ambiance** depuis la barre : les presets s'appliquent **sans reset** (la cire en place
  s'adapte) ; le select du panneau de debug, lui, reset.
- **Qualité adaptative** (`quality.ts`) : 6 niveaux (pixel ratio max 2 → 0.6, grille 48 → 32,
  pas 96 → 48, MSAA 4 → 0, bloom coupé au dernier). Descend si < 50 fps sur 1.5 s, remonte
  après 8 s à la cible. Une baisse qui ne gagne pas 5 % est annulée et bloque la descente
  1 min (vsync 30 Hz, physique CPU) ; un niveau qui a échoué n'est pas réessayé avant 1 min.
  Pointeur grossier (tactile) → départ au niveau « basse ».
- **Robustesse** : `visibilitychange` coupe la boucle ; cadrage recalculé au passage
  portrait ↔ paysage (hauteur × 1.3, cible abaissée de 0.3 pour dégager la barre) ;
  message dédié si WebGL2 absent ou contexte perdu.
- **UI** : barre en bas (thème, ambiance, pause, plein écran), masquée après 3.5 s sans
  interaction ; plein écran caché si l'API n'existe pas (iPhone). Tient de 320 à 390 px.
  Raccourcis : D (debug), F (plein écran), Espace (pause).
- Non mesuré ici (rendu logiciel SwiftShader) : temps GPU réel, 60 fps desktop, 30 fps
  mobile. Le compteur « rendu GPU » du panneau et le libellé de qualité les donnent sur
  une vraie machine.

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
   ✅ 3 quater : compromis gouttes plus grosses / pas de colonne (chauffe 3.3, ambiance haute 0.24).
4. ✅ Rendu raymarching du champ de densité dans le volume du verre (bornage par le profil).
5. ✅ Finition : verre physique + réfraction dans le volume, pièce sombre, halo, post-process,
   5 thèmes, UI minimale, allumage, qualité adaptative, robustesse, README.
6. Perf : profiling sur vraies machines (desktop, mobile), budget 60 / 30 fps.
