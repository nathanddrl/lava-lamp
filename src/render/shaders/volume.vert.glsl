// Faces arrière du volume intérieur du récipient : chaque fragment lance un rayon
// depuis la caméra, qui s'arrête au plus tard sur cette face.
varying vec3 vWorldPos;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
