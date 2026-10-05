// Halo de la lampe sur la table : lumière sortie du verre, plus forte au pied du socle,
// qui s'éteint en douceur. Additif, ne fait qu'éclaircir le sol.
varying vec2 vPlane;

uniform vec3 uColor;
uniform float uIntensity;
uniform float uInner;   // rayon du socle (le halo commence à son bord)
uniform float uReach;   // portée caractéristique

void main() {
  float r = length(vPlane);
  float d = max(0.0, r - uInner);
  // Pied lumineux étroit + nappe large.
  float glow = 0.55 * exp(-d / (0.18 * uReach)) + exp(-(d * d) / (uReach * uReach));
  // Sous le socle : rien (et pas de discontinuité au bord).
  glow *= smoothstep(uInner - 0.08, uInner + 0.02, r);
  gl_FragColor = vec4(uColor * (uIntensity * glow), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
