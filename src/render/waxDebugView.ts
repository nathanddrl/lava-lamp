import * as THREE from 'three';
import { MAX_PARTICLES, type WaxSystem } from '../sim/waxSystem';

/**
 * Rendu de debug de la cire : une petite sphère instanciée par particule.
 * Remplacé plus tard par le raymarching du champ de densité.
 */
export class WaxDebugView {
  readonly mesh: THREE.InstancedMesh;
  readonly params = { visible: true, sphereRadius: 0.045 };

  private readonly geometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xff5a2a,
    emissive: 0x7a1a05,
    roughness: 0.45,
    metalness: 0,
  });

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_PARTICLES);
    this.mesh.name = 'wax-debug';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Les positions changent à chaque frame : pas de bounding sphere fiable.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    const m = this.mesh.instanceMatrix.array;
    for (let i = 0; i < MAX_PARTICLES; i++) m[16 * i + 15] = 1;
  }

  /** Écrit les matrices d'instance en interpolant entre les deux derniers pas fixes. */
  update(wax: WaxSystem, alpha: number): void {
    this.mesh.visible = this.params.visible;
    if (!this.params.visible) return;

    const n = wax.count;
    const cur = wax.positions;
    const prev = wax.previousStepPositions;
    const s = this.params.sphereRadius;
    const a = Math.min(1, Math.max(0, alpha));
    const m = this.mesh.instanceMatrix.array;

    for (let i = 0; i < n; i++) {
      const o = 16 * i;
      m[o] = s;
      m[o + 5] = s;
      m[o + 10] = s;
      m[o + 12] = prev[3 * i]! + (cur[3 * i]! - prev[3 * i]!) * a;
      m[o + 13] = prev[3 * i + 1]! + (cur[3 * i + 1]! - prev[3 * i + 1]!) * a;
      m[o + 14] = prev[3 * i + 2]! + (cur[3 * i + 2]! - prev[3 * i + 2]!) * a;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, 16 * n);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
