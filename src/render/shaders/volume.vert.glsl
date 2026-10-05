// Faces avant du volume intérieur du récipient : chaque fragment est le point d'entrée
// du rayon dans le liquide, avec la normale de la paroi pour la réfraction.
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}
