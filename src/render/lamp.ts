import * as THREE from 'three';
import type { LampProfile, ProfilePoint } from '../sim/lampProfile';

const RADIAL_SEGMENTS = 96;

export interface GlassParams {
  /** Intensité des reflets (environnement + lumières) sur le verre. */
  reflection: number;
  roughness: number;
  ior: number;
  /** Voile laiteux du verre (diffusion), 0 = verre clair. */
  haze: number;
}

export const DEFAULT_GLASS_PARAMS: GlassParams = {
  reflection: 1,
  roughness: 0.08,
  ior: 1.5,
  haze: 0.03,
};

export interface LampView {
  readonly group: THREE.Group;
  readonly glassParams: GlassParams;
  /** À appeler quand `glassParams` change (panneau). */
  updateGlass(): void;
  dispose(): void;
}

function lathe(points: readonly ProfilePoint[]): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    points.map((p) => new THREE.Vector2(p.r, p.y)),
    RADIAL_SEGMENTS,
  );
}

/**
 * Verre physique sans transmission : on n'en garde que la réflexion (fresnel, ior,
 * rugosité, environnement PMREM), ajoutée par-dessus ce qu'il y a derrière. Le diffus
 * est noir, la couleur vue à travers vient du volume (qui gère la réfraction).
 * Rendu en deux passes : face arrière avant le volume, face avant après.
 */
function glassMaterial(side: THREE.Side, p: GlassParams): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0x000000,
    metalness: 0,
    roughness: p.roughness,
    ior: p.ior,
    specularIntensity: 1,
    clearcoat: 0.6,
    clearcoatRoughness: 0.04,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side,
  });
}

/** Construit les trois pièces de la lampe à partir du profil unique. */
export function createLampView(profile: LampProfile): LampView {
  const group = new THREE.Group();
  group.name = 'lamp';
  const glassParams: GlassParams = { ...DEFAULT_GLASS_PARAMS };

  // Métal brossé sombre : reflète la pièce (PMREM) et la lueur de l'ampoule.
  const metal = new THREE.MeshStandardMaterial({
    color: 0x6a6e78,
    metalness: 1,
    roughness: 0.36,
  });

  const base = new THREE.Mesh(lathe(profile.baseProfile()), metal);
  base.name = 'base';

  const glassGeometry = lathe(profile.glassProfile());
  const backMaterial = glassMaterial(THREE.BackSide, glassParams);
  const frontMaterial = glassMaterial(THREE.FrontSide, glassParams);
  // Voile laiteux : un soupçon de diffus sur la face avant seulement.
  const glassBack = new THREE.Mesh(glassGeometry, backMaterial);
  glassBack.name = 'glass-back';
  glassBack.renderOrder = 1;
  const glassFront = new THREE.Mesh(glassGeometry, frontMaterial);
  glassFront.name = 'glass-front';
  glassFront.renderOrder = 3;

  const cap = new THREE.Mesh(lathe(profile.capProfile()), metal);
  cap.name = 'cap';

  group.add(base, cap, glassBack, glassFront);

  const updateGlass = (): void => {
    for (const m of [backMaterial, frontMaterial]) {
      m.roughness = glassParams.roughness;
      m.ior = glassParams.ior;
      m.specularIntensity = glassParams.reflection;
      m.clearcoat = 0.6 * glassParams.reflection;
    }
    frontMaterial.color.setScalar(glassParams.haze);
    // Reflets intérieurs (face arrière vue à travers le liquide) plus discrets.
    backMaterial.specularIntensity = 0.5 * glassParams.reflection;
  };
  updateGlass();

  return {
    group,
    glassParams,
    updateGlass,
    dispose() {
      base.geometry.dispose();
      glassGeometry.dispose();
      cap.geometry.dispose();
      metal.dispose();
      backMaterial.dispose();
      frontMaterial.dispose();
    },
  };
}
