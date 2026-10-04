import * as THREE from 'three';
import type { LampProfile, ProfilePoint } from '../sim/lampProfile';

const RADIAL_SEGMENTS = 96;

export interface LampView {
  readonly group: THREE.Group;
  readonly glassMaterial: THREE.MeshPhysicalMaterial;
  dispose(): void;
}

function lathe(points: readonly ProfilePoint[]): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    points.map((p) => new THREE.Vector2(p.r, p.y)),
    RADIAL_SEGMENTS,
  );
}

/** Construit les trois pièces de la lampe à partir du profil unique. */
export function createLampView(profile: LampProfile): LampView {
  const group = new THREE.Group();
  group.name = 'lamp';

  const metal = new THREE.MeshStandardMaterial({
    color: 0x8a8f99,
    metalness: 0.9,
    roughness: 0.32,
  });

  // Verre provisoire : simple transparence, sera remplacé par un shader dédié.
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: 0.05,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const base = new THREE.Mesh(lathe(profile.baseProfile()), metal);
  base.name = 'base';

  const glass = new THREE.Mesh(lathe(profile.glassProfile()), glassMaterial);
  glass.name = 'glass';
  glass.renderOrder = 10;

  const cap = new THREE.Mesh(lathe(profile.capProfile()), metal);
  cap.name = 'cap';

  group.add(base, cap, glass);

  return {
    group,
    glassMaterial,
    dispose() {
      base.geometry.dispose();
      glass.geometry.dispose();
      cap.geometry.dispose();
      metal.dispose();
      glassMaterial.dispose();
    },
  };
}
