// Liquide : teinte volumique accumulée le long du rayon, éclairée par le bas.
// Passe transparente, faces arrière du volume intérieur : là où la cire est visible,
// son gl_FragDepth masque ce fragment (la cire a déjà intégré le liquide devant elle).
// Préfixé par volumeCommon.glsl.

uniform int uLiquidSteps;
const int MAX_LIQUID_STEPS = 64;

// Bruit de hachage pour décaler le départ du rayon (évite le banding des pas réguliers).
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 ro = cameraPosition;
  vec3 toBack = vWorldPos - ro;
  float tBack = length(toBack);
  vec3 rd = toBack / tBack;

  vec2 tb = boundsIntersect(ro, rd);
  float t0 = max(tb.x, 0.0);
  float t1 = min(tb.y, tBack);
  if (t1 <= t0) discard;

  float dt = (t1 - t0) / float(uLiquidSteps);
  float jitter = hash12(gl_FragCoord.xy);
  vec3 transmittance = vec3(1.0);
  vec3 inscatter = vec3(0.0);
  for (int i = 0; i < MAX_LIQUID_STEPS; i++) {
    if (i >= uLiquidSteps) break;
    vec3 p = ro + rd * (t0 + (float(i) + jitter) * dt);
    integrateLiquid(p, liquidMask(p), dt, transmittance, inscatter);
  }

  // Prémultiplié : couleur de fond × transmittance moyenne + lumière diffusée.
  float alpha = 1.0 - dot(transmittance, vec3(1.0 / 3.0));
  gl_FragColor = vec4(inscatter, alpha);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
