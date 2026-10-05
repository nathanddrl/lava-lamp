// Fonctions du liquide et du récipient, préfixées à volume.frag.glsl.

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

// Rayon intérieur du verre en fonction de la hauteur normalisée (LampProfile.innerRadius).
uniform sampler2D uRadiusLut;
uniform float uYMin;
uniform float uYMax;
uniform float uMaxRadius;
// Épaisseur de la transition « dans le liquide » contre le verre.
uniform float uWallSoftness;

uniform vec3 uLiquidAbsorption;  // coefficient d'extinction par canal (1/unité)
uniform vec3 uLiquidScatter;     // couleur diffusée par le liquide
uniform float uLiquidGlow;       // coefficient de diffusion (1/unité), découplé de l'absorption
uniform vec3 uBulbPosition;
uniform vec3 uBulbColor;
uniform float uBulbIntensity;
uniform float uLiquidGlowHeight; // hauteur caractéristique de la lueur de l'ampoule
uniform vec3 uAmbientColor;
uniform float uPower;            // puissance de la lampe (0 = éteinte, 1 = régime), allumage

// 1 dans le liquide, 0 hors du récipient, transition douce contre le verre.
float liquidMask(vec3 p) {
  float h = (p.y - uYMin) / (uYMax - uYMin);
  float R = texture(uRadiusLut, vec2(clamp(h, 0.0, 1.0), 0.5)).r;
  float side = clamp((R - length(p.xz)) / uWallSoftness, 0.0, 1.0);
  float vertical = clamp(min(p.y - uYMin, uYMax - p.y) / uWallSoftness, 0.0, 1.0);
  return side * vertical;
}

// Intersection rayon / boîte englobante du liquide : (tEntrée, tSortie).
vec2 boundsIntersect(vec3 ro, vec3 rd) {
  vec3 bmin = vec3(-uMaxRadius, uYMin, -uMaxRadius);
  vec3 bmax = vec3(uMaxRadius, uYMax, uMaxRadius);
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}

// Lumière reçue par le liquide en p : lueur de l'ampoule par le dessous (décroît avec
// la hauteur et en s'écartant de l'axe) + un peu d'ambiance.
vec3 liquidLight(vec3 p) {
  float above = max(0.0, p.y - uYMin);
  vec3 toBulb = p - uBulbPosition;
  float spread = exp(-dot(toBulb.xz, toBulb.xz) * 2.0);
  float glow = exp(-above / uLiquidGlowHeight) * (0.35 + 0.65 * spread);
  return uBulbColor * (uBulbIntensity * uPower * glow) + uAmbientColor;
}

// Intègre le liquide sur un segment de longueur ds (masque m) : transmittance et
// lumière diffusée vers l'œil. Diffusion et absorption sont séparées : un liquide
// jaune absorbe peu le rouge mais doit quand même briller de sa couleur.
void integrateLiquid(vec3 p, float m, float ds, inout vec3 transmittance, inout vec3 inscatter) {
  if (m <= 0.0) return;
  vec3 stepT = exp(-uLiquidAbsorption * m * ds);
  inscatter += transmittance * uLiquidScatter * liquidLight(p) * (uLiquidGlow * m * ds);
  transmittance *= stepT;
}
