import * as THREE from 'three';
import { MAX_PARTICLES, type WaxSystem } from '../sim/waxSystem';

/**
 * Rendu de debug de la cire : une petite sphère instanciée par particule.
 * Remplacé plus tard par le raymarching du champ de densité.
 */
export class WaxDebugView {
  readonly mesh: THREE.InstancedMesh;
  readonly params = { visible: true, sphereRadius: 0.036 };

  private readonly geometry = new THREE.IcosahedronGeometry(1, 1);
  // Blanc : la couleur vient de l'attribut d'instance (température).
  private readonly material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0 });
  private readonly colors = new Float32Array(MAX_PARTICLES * 3);
  private readonly cold = new THREE.Color(0x2a5cff);
  private readonly hot = new THREE.Color(0xff3a10);

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, MAX_PARTICLES);
    this.mesh.name = 'wax-debug';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Les positions changent à chaque frame : pas de bounding sphere fiable.
    this.mesh.frustumCulled = false;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
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
    // Bleu (froid) → rouge (chaud), via un blanc chaud au milieu pour lire Tn.
    const T = wax.temperatures;
    const c = this.colors;
    const { cold, hot } = this;
    for (let i = 0; i < n; i++) {
      const t = Math.min(1, Math.max(0, T[i]!));
      const k = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const r0 = t < 0.5 ? cold.r : 1;
      const g0 = t < 0.5 ? cold.g : 0.85;
      const b0 = t < 0.5 ? cold.b : 0.7;
      const r1 = t < 0.5 ? 1 : hot.r;
      const g1 = t < 0.5 ? 0.85 : hot.g;
      const b1 = t < 0.5 ? 0.7 : hot.b;
      c[3 * i] = r0 + (r1 - r0) * k;
      c[3 * i + 1] = g0 + (g1 - g0) * k;
      c[3 * i + 2] = b0 + (b1 - b0) * k;
    }
    const colorAttr = this.mesh.instanceColor!;
    colorAttr.clearUpdateRanges();
    colorAttr.addUpdateRange(0, 3 * n);
    colorAttr.needsUpdate = true;
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
