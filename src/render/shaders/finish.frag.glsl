// Finition, après le tone mapping : vignette légère et grain très discret (animé).
uniform sampler2D tDiffuse;
uniform float uVignette;  // assombrissement des coins (0 = aucun)
uniform float uGrain;     // amplitude du grain, en fraction de la valeur
uniform float uTime;
uniform vec2 uAspect;     // (largeur / hauteur, 1) : vignette ronde quel que soit le format

varying vec2 vUv;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  vec2 q = (vUv - 0.5) * uAspect / max(uAspect.x, 1.0);
  float v = 1.0 - uVignette * smoothstep(0.25, 0.85, length(q) * 1.25);
  c.rgb *= v;
  // Grain centré, plus visible dans les tons moyens que dans les noirs (comme un film).
  float n = hash(gl_FragCoord.xy + fract(uTime * 7.13) * 917.0) - 0.5;
  float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  c.rgb += n * uGrain * (0.25 + sqrt(luma));
  gl_FragColor = c;
}
