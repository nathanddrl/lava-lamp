# Lava Lamp

Une lampe à lave simulée en temps réel dans le navigateur. La cire est faite de 800
particules (fluide visco-élastique de Clavet et al. 2005) avec une thermique simple :
le fond la chauffe, le haut la refroidit, la flottabilité dépend de la température.
Sa surface est obtenue en raymarchant un champ de densité construit à partir des
particules, dans le volume exact du verre.

Vite, TypeScript strict, Three.js (WebGL2), aucune dépendance physique externe.

```
npm install
npm run dev          # http://localhost:5173
npm run build        # typecheck + build de prod dans dist/
npm test             # vitest
npm run bench        # banc headless de la thermique (gouttes, colonne, verdicts)
npm run bench:splat  # banc du champ de densité (coût CPU, scintillement)
```

## Utilisation

Au chargement, la lampe s'allume : la cire part froide au fond, l'ampoule monte en
puissance et la simulation tourne en accéléré pendant quelques secondes, le temps que le
point chaud fonde.

| Contrôle | Effet |
|---|---|
| Glisser / pincer | Tourner autour de la lampe, zoomer |
| Pastilles | Thème (5 palettes, transition en fondu) |
| Calme · Équilibré · Agité | Ambiance thermique, sans redémarrer la cire |
| `Espace` | Pause |
| `F` | Plein écran |
| `D` | Panneau de debug (lil-gui) |

La barre se retire après quelques secondes sans interaction et revient au moindre
mouvement ou toucher. Laissée tranquille 1,5 s, la caméra tourne lentement autour de la
lampe (un tour en deux minutes) ; elle s'arrête dès qu'on la reprend en main.

## Architecture

```
src/
  sim/       Physique pure, sans Three.js ni DOM, déterministe à pas fixe.
             lampProfile (géométrie de révolution), waxSystem (Clavet 2005 + thermique),
             spatialHashGrid, presets, simulation.
  render/    Tout ce qui touche Three.js.
             stage           scène, caméra, pièce sombre, environnement PMREM, cadrage
             densityField    splatting CPU des particules en grille 3D (pur TS, testé)
             waxSurfaceView  texture 3D + volume raymarché (cire et liquide)
             lamp            socle, capuchon, verre physique en deux passes
             halo            halo coloré au sol
             postprocess     HDR → bloom → ACES → vignette, grain
             themes          palettes et transition
             quality         qualité adaptative (logique pure, testée)
             shaders/        GLSL ES 3.00
  ui/        controlBar (interface finale), debugPanel (lil-gui), aucun calcul métier.
  main.ts    Assemblage, boucle à pas fixe, allumage, clavier, onglet caché, erreurs.
scripts/     Bancs headless (tsx).
```

Les dépendances vont `main → render → sim` et `main → ui` ; la physique n'importe jamais
le rendu.

### Une frame

1. **Physique** : accumulateur à pas fixe (1/60 s, 2 sous-pas), découplé du framerate.
2. **Champ** : les particules, interpolées entre les deux derniers pas, sont splattées
   dans une grille 48 × 94 × 48 (noyau séparable (1 − u²)³, deux canaux : densité et
   température), lissées dans le temps, uploadées en texture 3D. Une grille
   d'occupation 4³ marque les blocs où il y a de la cire.
3. **Volume** : un seul shader sur les faces avant du volume intérieur du verre. Le rayon
   est réfracté à l'entrée (liquide d'indice 1,38), traverse les blocs vides d'un saut,
   cherche l'isosurface par pas puis bissection, et accumule le liquide (absorption et
   diffusion séparées, lueur de l'ampoule par le bas). La cire est opaque et écrit sa
   profondeur ; sinon la sortie est le liquide seul, en alpha prémultiplié.
4. **Verre** : `MeshPhysicalMaterial` sans transmission (reflets d'environnement,
   fresnel, ior 1,5, clearcoat), face arrière avant le volume, face avant après.
5. **Post-process** : cible demi-flottants MSAA → bloom seuillé (seul l'émissif dépasse)
   → tone mapping ACES et sRGB → vignette et grain.

**Pourquoi la réfraction est dans le shader et pas en transmission :** Three.js rend la
transmission en re-dessinant tous les objets opaques dans une cible MSAA séparée. Le
raymarch serait calculé deux fois par frame, ce qui est rédhibitoire sur mobile.

## Paramètres

Tout se règle dans le panneau de debug (`D`). Les principaux :

| Groupe | Paramètre | Rôle |
|---|---|---|
| Thermique | chauffe, rayon, délai de fusion | Fréquence et taille des gouttes ; trop de chauffe ramène une colonne permanente |
| Champ | seuil (0,5), rayon du noyau (0,085), résolution, lissage temporel | Forme et douceur de la surface |
| Cire et liquide | couleurs, densité et diffusion du liquide, ior, subsurface, émission | Aspect |
| Verre | reflets, rugosité, ior, voile | Aspect du verre |
| Pièce | environnement, appoint, ampoule, halo | Ambiance lumineuse |
| Post-process | bloom (force, rayon, seuil), exposition, vignette, grain | Finition |
| Qualité adaptative | active, fps visés, seuil de dégradation | Robustesse |

Le panneau affiche aussi les chronos : ms par pas de physique, splatting CPU, rendu CPU,
rendu GPU (`EXT_disjoint_timer_query_webgl2`, Chrome et Edge) et le niveau de qualité.

## Robustesse

- **Qualité adaptative** : six niveaux (pixel ratio, résolution de grille, pas du
  raymarch, MSAA, bloom). Le moteur descend sous 50 fps et remonte après 8 s stables. Il
  annule une baisse qui ne fait pas remonter le framerate (écran à 30 Hz, physique
  limitée par le CPU), et ne réessaie pas tout de suite un niveau qui a échoué.
  Les écrans tactiles démarrent au niveau « basse ».
- **Onglet caché** : la boucle s'arrête et reprend sans rattrapage.
- **Responsive** : la caméra recule pour cadrer toute la lampe, en portrait comme en
  paysage. La barre tient jusqu'à 320 px de large et respecte les encoches.
- **WebGL2 absent ou contexte perdu** : un message lisible remplace la scène.

## Références

- S. Clavet, P. Beaudoin, P. Poulin, *Particle-based Viscoelastic Fluid Simulation*,
  SCA 2005 (double density relaxation, viscosité par impulsions).
- J. Blinn, *A Generalization of Algebraic Surface Drawing*, 1982 (metaballs, isosurface
  d'un champ de densité).
- F. N. Fritsch, R. E. Carlson, *Monotone Piecewise Cubic Interpolation*, 1980 (profil
  du verre).
- C. Sigg, M. Hadwiger, *Fast Third-Order Texture Filtering*, GPU Gems 2, 2005 (essayé
  pour les normales, non retenu).
- Three.js : `RoomEnvironment` + `PMREMGenerator`, `UnrealBloomPass`, `OutputPass`.
