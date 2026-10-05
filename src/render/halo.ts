import * as THREE from 'three';
import haloVert from './shaders/halo.vert.glsl?raw';
import haloFrag from './shaders/halo.frag.glsl?raw';

/** Halo coloré projeté par la lampe sur la table (disque additif posé sur le sol). */
export class FloorHalo {
  readonly mesh: THREE.Mesh;
  readonly params = { intensity: 0.5, reach: 1.1 };
  readonly color = new THREE.Color();

  private readonly material: THREE.ShaderMaterial;

  constructor(baseRadius: number) {
    this.material = new THREE.ShaderMaterial({
      name: 'floor-halo',
      uniforms: {
        uColor: { value: this.color },
        uIntensity: { value: 0 },
        uInner: { value: baseRadius },
        uReach: { value: 1 },
      },
      vertexShader: haloVert,
      fragmentShader: haloFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const geometry = new THREE.CircleGeometry(baseRadius + 5, 96);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'floor-halo';
    this.mesh.rotation.x = -Math.PI / 2;
    // Juste au-dessus du sol : pas de z-fighting.
    this.mesh.position.y = 0.002;
    this.mesh.renderOrder = 0;
  }

  update(colorHex: string, power: number): void {
    this.color.set(colorHex);
    const u = this.material.uniforms;
    u.uIntensity!.value = this.params.intensity * power;
    u.uReach!.value = this.params.reach;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
