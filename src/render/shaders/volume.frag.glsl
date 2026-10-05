// Cire + liquide en une passe : le rayon entre dans le liquide par la face avant du
// volume intérieur, y est réfracté (air → liquide, à travers une paroi de verre mince),
// puis on raymarche l'isosurface du champ de densité (texture 3D) en accumulant le
// liquide. Préfixé par volumeCommon.glsl.
//
// Sortie prémultipliée : cire touchée → opaque, avec gl_FragDepth au point touché ;
// sinon le liquide seul, alpha = opacité moyenne, profondeur = face d'entrée.

// Fourni par Three.js mais pas déclaré dans le préfixe des fragment shaders.
uniform mat4 projectionMatrix;

uniform highp sampler3D uField;  // R = densité, G = température × densité
uniform vec3 uFieldMin;
uniform vec3 uFieldSize;
uniform float uVoxel;            // taille d'un voxel (unités monde)
uniform highp sampler3D uOccupancy; // 1 = bloc pouvant contenir de la cire
uniform vec3 uOccupancyDims;
uniform float uBlockSize;        // côté d'un bloc d'occupation (unités monde)
uniform float uThreshold;
uniform int uSteps;
uniform bool uWaxVisible;
uniform float uIor;              // indice du liquide (le verre mince ne dévie pas en net)

uniform vec3 uWaxColor;          // cire froide
uniform vec3 uWaxHotColor;       // cire chaude
uniform vec3 uWaxDeepColor;      // couleur de la lumière qui a traversé la cire
uniform vec3 uKeyDirection;      // vers la lumière principale
uniform vec3 uKeyColor;
uniform vec3 uRimDirection;
uniform vec3 uRimColor;
uniform float uWrap;
uniform float uSubsurface;
uniform float uThicknessScale;   // extinction dans la cire (1/unité)
uniform float uEmission;
uniform float uBulbReach;        // portée de l'émission induite par l'ampoule
uniform float uFresnel;

const int MAX_STEPS = 256;
const int BISECTIONS = 6;
const int THICKNESS_STEPS = 10;

vec2 fieldAt(vec3 p) {
  return texture(uField, (p - uFieldMin) / uFieldSize).rg;
}

// Densité vue par le raymarch : nulle hors du liquide, la cire s'aplatit contre le verre.
float waxDensity(vec3 p) {
  return fieldAt(p).r * liquidMask(p);
}

// Normale = −∇densité par différences centrales sur un voxel. Le champ trilinéaire
// n'est que C0, mais le noyau de splatting couvre ~3.5 voxels : en pratique pas de
// couches visibles (testé contre un filtrage B-spline tricubique, 8× plus cher).
vec3 waxNormal(vec3 p) {
  float e = uVoxel;
  vec3 g = vec3(
    waxDensity(p + vec3(e, 0, 0)) - waxDensity(p - vec3(e, 0, 0)),
    waxDensity(p + vec3(0, e, 0)) - waxDensity(p - vec3(0, e, 0)),
    waxDensity(p + vec3(0, 0, e)) - waxDensity(p - vec3(0, 0, e))
  );
  float len = length(g);
  return len > 1e-6 ? -g / len : vec3(0.0, 1.0, 0.0);
}

float wrapDiffuse(vec3 n, vec3 l, float w) {
  return max(0.0, (dot(n, l) + w) / (1.0 + w));
}

float depthOf(vec3 p) {
  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  return clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
}

vec3 shadeWax(vec3 p, vec3 rd) {
  vec3 n = waxNormal(p);
  vec3 v = -rd;

  vec2 f = fieldAt(p);
  float temperature = clamp(f.g / max(f.r, 1e-4), 0.0, 1.0);
  float hot = smoothstep(0.3, 0.75, temperature);
  vec3 albedo = mix(uWaxColor, uWaxHotColor, hot);

  // Épaisseur traversée le long du rayon : les cols, les bords et les petites gouttes
  // sont fins et laissent passer la lumière de l'ampoule. Pas croissants (jusqu'à
  // ~0.3 unité) et poids continu en densité : pas de paliers quand un échantillon
  // franchit la surface.
  float thickness = 0.0;
  float tPrevK = 0.0;
  for (int k = 1; k <= THICKNESS_STEPS; k++) {
    float fk = float(k) / float(THICKNESS_STEPS);
    float tk = 0.3 * fk * fk;
    float d = waxDensity(p + rd * tk);
    thickness += smoothstep(0.2 * uThreshold, 1.6 * uThreshold, d) * (tk - tPrevK);
    tPrevK = tk;
  }
  float transmission = exp(-thickness * uThicknessScale);

  vec3 toBulb = uBulbPosition - p;
  float bulbDist = length(toBulb);
  vec3 lb = toBulb / bulbDist;
  float bulb = uBulbIntensity * uPower;
  // Ampoule large (diffusée par le fond de verre) : pas de point brûlé juste au-dessus.
  float bulbFalloff = bulb / (1.0 + 10.0 * bulbDist * bulbDist);
  float bulbNear = exp(-max(0.0, p.y - uYMin) / uBulbReach);

  // Éclairage cireux : diffusion « wrap » (pas de terminateur dur), peu de spéculaire.
  // Pièce sombre : l'ampoule domine, la clé et le contre-jour ne font que dessiner.
  vec3 diffuse =
      uKeyColor * wrapDiffuse(n, uKeyDirection, uWrap) +
      uRimColor * wrapDiffuse(n, uRimDirection, uWrap) +
      uBulbColor * bulbFalloff * wrapDiffuse(n, lb, uWrap * 1.5) +
      uAmbientColor * (0.6 + 0.4 * n.y);
  vec3 color = albedo * diffuse;

  // Faux subsurface : lumière de l'ampoule transmise à travers l'épaisseur, renforcée
  // à contre-jour (l'œil regarde vers l'ampoule à travers la cire).
  float backLit = 0.4 + 0.6 * pow(max(0.0, dot(v, -lb)), 2.0);
  color += uWaxDeepColor * uBulbColor * (bulbFalloff + 0.3 * uPower) * transmission * backLit * uSubsurface;

  // Émission : cire chaude, et proche de l'ampoule (cire éclairée en profondeur).
  // Dépasse 1 en linéaire près du fond : c'est ce que le bloom attrape.
  color += uWaxHotColor * uEmission * uPower * (0.35 * hot + 0.9 * bulbNear) * (0.5 + 0.5 * transmission);

  // Fresnel doux : un voile de lumière du liquide sur les bords, pas de reflet net.
  float fres = pow(1.0 - max(0.0, dot(n, v)), 3.0) * uFresnel;
  vec3 h = normalize(uKeyDirection + v);
  float spec = pow(max(0.0, dot(n, h)), 12.0) * 0.06;
  return mix(color, uLiquidScatter * liquidLight(p) + uAmbientColor, fres) + uKeyColor * spec;
}

void main() {
  vec3 view = normalize(vWorldPos - cameraPosition);
  vec3 n = normalize(vWorldNormal);
  // Réfraction à l'entrée : le cylindre de liquide agit comme une lentille, la cire
  // paraît élargie et se déforme près des bords du verre.
  vec3 rd = refract(view, n, 1.0 / uIor);
  if (dot(rd, rd) < 1e-6) rd = view;
  vec3 ro = vWorldPos - n * 1e-3;

  float t0 = 0.0;
  float t1 = boundsIntersect(ro, rd).y;

  vec3 transmittance = vec3(1.0);
  vec3 inscatter = vec3(0.0);
  float tHit = -1.0;

  if (t1 > t0) {
    // Pas uniforme sur le segment, jamais plus fin qu'un demi-voxel.
    float dt = max((t1 - t0) / float(uSteps), 0.5 * uVoxel);
    vec3 invRd = 1.0 / rd;
    float t = t0;
    float tPrev = t0;
    int fineSteps = 0;
    for (int i = 0; i < MAX_STEPS; i++) {
      vec3 p = ro + rd * t;
      vec3 block = floor((p - uFieldMin) / uBlockSize);
      if (!uWaxVisible || texture(uOccupancy, (block + 0.5) / uOccupancyDims).r < 0.5) {
        // Bloc vide : saut direct à sa sortie (le liquide y est intégré d'un seul segment).
        vec3 bmin = uFieldMin + block * uBlockSize;
        vec3 ta = (bmin - ro) * invRd;
        vec3 tb = (bmin + uBlockSize - ro) * invRd;
        vec3 tfar = max(ta, tb);
        float tNext = min(min(min(tfar.x, tfar.y), tfar.z) + 1e-3, t1);
        vec3 mid = ro + rd * (0.5 * (tPrev + tNext));
        integrateLiquid(mid, liquidMask(mid), tNext - tPrev, transmittance, inscatter);
        tPrev = tNext;
        t = tNext;
        if (t >= t1) break;
        continue;
      }
      float m = liquidMask(p);
      float d = fieldAt(p).r * m;
      if (d >= uThreshold) {
        // Raffinement par bissection entre le dernier point dehors et le premier dedans.
        float a = tPrev;
        float b = t;
        for (int k = 0; k < BISECTIONS; k++) {
          float mid = 0.5 * (a + b);
          if (waxDensity(ro + rd * mid) >= uThreshold) b = mid; else a = mid;
        }
        tHit = b;
        integrateLiquid(ro + rd * (0.5 * (tPrev + b)), m, b - tPrev, transmittance, inscatter);
        break;
      }
      integrateLiquid(p, m, t - tPrev, transmittance, inscatter);
      tPrev = t;
      if (t >= t1 || ++fineSteps >= uSteps) break;
      t = min(t + dt, t1);
    }
  }

  if (tHit >= 0.0) {
    vec3 p = ro + rd * tHit;
    gl_FragColor = vec4(shadeWax(p, rd) * transmittance + inscatter, 1.0);
    gl_FragDepth = depthOf(p);
  } else {
    // Prémultiplié : couleur de fond × transmittance moyenne + lumière diffusée.
    float alpha = 1.0 - dot(transmittance, vec3(1.0 / 3.0));
    gl_FragColor = vec4(inscatter, alpha);
    gl_FragDepth = gl_FragCoord.z;
  }

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
