import * as THREE from 'three';
import type { LampProfile } from '../sim/lampProfile';
import type { WaxSystem } from '../sim/waxSystem';
import { DensityField, OCCUPANCY_BLOCK, clavetReferenceDensity } from './densityField';
import volumeVert from './shaders/volume.vert.glsl?raw';
import volumeCommon from './shaders/volumeCommon.glsl?raw';
import volumeFrag from './shaders/volume.frag.glsl?raw';

const RADIUS_LUT_SIZE = 256;
const RADIAL_SEGMENTS = 64;

/** Réglages du rendu de la cire et du liquide (exposés dans le panneau). */
export interface WaxSurfaceParams {
  visible: boolean;
  liquidVisible: boolean;
  /** Seuil de l'isosurface (champ ≈ 1 au cœur de la cire). */
  threshold: number;
  /** Nombre maximal de pas du raymarch de la cire. */
  steps: number;
  /** Indice de réfraction du liquide (lentille cylindrique). 1 = pas de réfraction. */
  ior: number;
  waxColor: string;
  waxHotColor: string;
  waxDeepColor: string;
  liquidColor: string;
  bulbColor: string;
  /** Densité optique du liquide (1/unité) : teinte de ce qu'on voit à travers. */
  liquidDensity: number;
  /** Diffusion du liquide (1/unité) : à quel point il s'illumine sous l'ampoule. */
  liquidGlow: number;
  bulbIntensity: number;
  subsurface: number;
  thicknessScale: number;
  emission: number;
  wrap: number;
  fresnel: number;
}

export const DEFAULT_WAX_SURFACE_PARAMS: WaxSurfaceParams = {
  visible: true,
  liquidVisible: true,
  threshold: 0.5,
  steps: 96,
  ior: 1.38,
  // Couleurs : écrasées par le thème (src/render/themes.ts).
  waxColor: '#d8381c',
  waxHotColor: '#ff7a1e',
  waxDeepColor: '#ff5a1a',
  liquidColor: '#ffb347',
  bulbColor: '#ffb070',
  liquidDensity: 0.45,
  liquidGlow: 0.5,
  bulbIntensity: 2.6,
  subsurface: 1.1,
  thicknessScale: 9,
  emission: 0.55,
  wrap: 0.6,
  fresnel: 0.35,
};

/**
 * Surface de la cire et liquide : champ de densité splatté sur CPU (DensityField),
 * uploadé en texture 3D, raymarché dans le volume intérieur du verre.
 *
 * Un seul mesh (`volumeMesh`) : faces avant du volume intérieur fermé. Le fragment
 * réfracte le rayon à l'entrée, cherche l'isosurface en accumulant le liquide, puis
 * écrit soit la cire (opaque, gl_FragDepth au point touché), soit le liquide seul
 * (prémultiplié, profondeur de la face d'entrée). Passe transparente, entre la face
 * arrière du verre et sa face avant (voir lamp.ts).
 *
 * La réfraction est faite ici plutôt que par la transmission de MeshPhysicalMaterial :
 * celle-ci re-rend tous les objets opaques dans une cible MSAA séparée, ce qui ferait
 * calculer le raymarch deux fois par frame.
 */
export class WaxSurfaceView {
  readonly params: WaxSurfaceParams = { ...DEFAULT_WAX_SURFACE_PARAMS };
  readonly field: DensityField;
  readonly volumeMesh: THREE.Mesh;
  /** Puissance de la lampe (0 = éteinte, 1 = régime) : pilotée par l'allumage. */
  power = 1;
  /** Temps CPU moyen du splatting + préparation de l'upload (ms). */
  splatMs = 0;

  private readonly geometry: THREE.LatheGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly radiusLut: THREE.DataTexture;
  private texture: THREE.Data3DTexture | null = null;
  private occupancyTexture: THREE.Data3DTexture | null = null;
  private textureVersion = -1;
  private readonly halfFloatField: boolean;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor(profile: LampProfile, wax: WaxSystem, renderer: THREE.WebGLRenderer) {
    let maxRadius = 0;
    for (const p of profile.innerProfile(256)) maxRadius = Math.max(maxRadius, p.r);

    this.field = new DensityField(
      { radius: maxRadius, yMin: profile.yMin, yMax: profile.yMax },
      clavetReferenceDensity(wax.params.restDensity, wax.params.interactionRadius),
    );
    // Sans filtrage linéaire des flottants 32 bits, on stocke en demi-flottants
    // (filtrables partout en WebGL2) : le pilote convertit à l'upload.
    this.halfFloatField = !renderer.extensions.has('OES_texture_float_linear');

    const lut = new Float32Array(RADIUS_LUT_SIZE);
    for (let i = 0; i < RADIUS_LUT_SIZE; i++) {
      const y = profile.yMin + (i / (RADIUS_LUT_SIZE - 1)) * (profile.yMax - profile.yMin);
      lut[i] = profile.innerRadius(Math.min(profile.yMax, Math.max(profile.yMin, y)));
    }
    this.radiusLut = new THREE.DataTexture(lut, RADIUS_LUT_SIZE, 1, THREE.RedFormat, THREE.FloatType);
    this.radiusLut.internalFormat = 'R16F';
    this.radiusLut.minFilter = THREE.LinearFilter;
    this.radiusLut.magFilter = THREE.LinearFilter;
    this.radiusLut.wrapS = THREE.ClampToEdgeWrapping;
    this.radiusLut.needsUpdate = true;

    // Volume intérieur fermé (fond, paroi, plafond), ordonné de bas en haut comme les autres Lathe.
    const inner = profile.innerProfile(64);
    const first = inner[0]!;
    const last = inner[inner.length - 1]!;
    const points = [
      new THREE.Vector2(0, first.y),
      ...inner.map((p) => new THREE.Vector2(p.r, p.y)),
      new THREE.Vector2(0, last.y),
    ];
    this.geometry = new THREE.LatheGeometry(points, RADIAL_SEGMENTS);

    const key = new THREE.Vector3(4, 7, 5).normalize();
    const rim = new THREE.Vector3(-5, 3, -4).normalize();
    this.uniforms = {
      uField: { value: null },
      uFieldMin: { value: new THREE.Vector3() },
      uFieldSize: { value: new THREE.Vector3() },
      uVoxel: { value: 0 },
      uOccupancy: { value: null },
      uOccupancyDims: { value: new THREE.Vector3() },
      uBlockSize: { value: 0 },
      uThreshold: { value: 0 },
      uSteps: { value: 0 },
      uWaxVisible: { value: true },
      uIor: { value: 1 },
      uRadiusLut: { value: this.radiusLut },
      uYMin: { value: profile.yMin },
      uYMax: { value: profile.yMax },
      uMaxRadius: { value: maxRadius },
      uWallSoftness: { value: 0.025 },
      uLiquidAbsorption: { value: new THREE.Vector3() },
      uLiquidScatter: { value: new THREE.Color() },
      uLiquidGlow: { value: 0 },
      // L'ampoule est dans le socle, sous le fond du verre.
      uBulbPosition: { value: new THREE.Vector3(0, profile.glassBottom - 0.12, 0) },
      uBulbColor: { value: new THREE.Color() },
      uBulbIntensity: { value: 0 },
      uPower: { value: 1 },
      uLiquidGlowHeight: { value: 0.6 },
      // Pièce sombre : presque rien hors de l'ampoule.
      uAmbientColor: { value: new THREE.Color(0.02, 0.02, 0.03) },
      uWaxColor: { value: new THREE.Color() },
      uWaxHotColor: { value: new THREE.Color() },
      uWaxDeepColor: { value: new THREE.Color() },
      uKeyDirection: { value: key },
      uKeyColor: { value: new THREE.Color(0.18, 0.18, 0.2) },
      uRimDirection: { value: rim },
      uRimColor: { value: new THREE.Color(0.05, 0.06, 0.14) },
      uWrap: { value: 0 },
      uSubsurface: { value: 0 },
      uThicknessScale: { value: 0 },
      uEmission: { value: 0 },
      uBulbReach: { value: 0.35 },
      uFresnel: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      name: 'wax-liquid-volume',
      uniforms: this.uniforms,
      vertexShader: volumeVert,
      fragmentShader: `${volumeCommon}\n${volumeFrag}`,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: true,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.volumeMesh = new THREE.Mesh(this.geometry, this.material);
    this.volumeMesh.name = 'wax-liquid-volume';
    // Entre la face arrière du verre (renderOrder 1) et sa face avant (3).
    this.volumeMesh.renderOrder = 2;
  }

  /** Splatte les particules (interpolées) dans le champ et prépare l'upload. */
  update(wax: WaxSystem, alpha: number, frameDt: number): void {
    const p = this.params;
    this.volumeMesh.visible = p.visible || p.liquidVisible;
    if (!this.volumeMesh.visible) return;
    const u = this.uniforms;

    if (p.visible) {
      const t0 = performance.now();
      const field = this.field;
      field.update(wax.positions, wax.previousStepPositions, wax.temperatures, wax.count, alpha, frameDt);
      if (field.version !== this.textureVersion) this.recreateTexture();
      this.texture!.needsUpdate = true;
      this.occupancyTexture!.needsUpdate = true;
      const ms = performance.now() - t0;
      this.splatMs += (ms - this.splatMs) * 0.05;
    } else if (!this.texture) {
      this.recreateTexture();
    }

    u.uWaxVisible!.value = p.visible;
    u.uThreshold!.value = p.threshold;
    u.uSteps!.value = Math.round(p.steps);
    u.uIor!.value = Math.max(1, p.ior);
    u.uPower!.value = this.power;
    (u.uBulbColor!.value as THREE.Color).set(p.bulbColor);
    (u.uWaxColor!.value as THREE.Color).set(p.waxColor);
    (u.uWaxHotColor!.value as THREE.Color).set(p.waxHotColor);
    (u.uWaxDeepColor!.value as THREE.Color).set(p.waxDeepColor);
    const liquid = u.uLiquidScatter!.value as THREE.Color;
    liquid.set(p.liquidColor);
    if (!p.liquidVisible) liquid.setRGB(0, 0, 0);
    // Le liquide absorbe le complémentaire de sa couleur : il teinte ce qu'on voit à travers.
    const density = p.liquidVisible ? p.liquidDensity : 0;
    (u.uLiquidAbsorption!.value as THREE.Vector3).set(
      density * (0.15 + 1 - liquid.r),
      density * (0.15 + 1 - liquid.g),
      density * (0.15 + 1 - liquid.b),
    );
    u.uLiquidGlow!.value = p.liquidVisible ? p.liquidGlow : 0;
    u.uBulbIntensity!.value = p.bulbIntensity;
    u.uSubsurface!.value = p.subsurface;
    u.uThicknessScale!.value = p.thicknessScale;
    u.uEmission!.value = p.emission;
    u.uWrap!.value = p.wrap;
    u.uFresnel!.value = p.fresnel;
  }

  private recreateTexture(): void {
    const f = this.field;
    this.texture?.dispose();
    const tex = new THREE.Data3DTexture(f.data, f.nx, f.ny, f.nz);
    tex.format = THREE.RGFormat;
    tex.type = THREE.FloatType;
    tex.internalFormat = this.halfFloatField ? 'RG16F' : 'RG32F';
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.generateMipmaps = false;
    this.texture = tex;
    this.textureVersion = f.version;

    this.occupancyTexture?.dispose();
    const occ = new THREE.Data3DTexture(f.occupancy, f.bx, f.by, f.bz);
    occ.format = THREE.RedFormat;
    occ.type = THREE.UnsignedByteType;
    occ.minFilter = THREE.NearestFilter;
    occ.magFilter = THREE.NearestFilter;
    occ.unpackAlignment = 1;
    occ.generateMipmaps = false;
    this.occupancyTexture = occ;

    const u = this.uniforms;
    u.uField!.value = tex;
    (u.uFieldMin!.value as THREE.Vector3).set(f.min.x, f.min.y, f.min.z);
    (u.uFieldSize!.value as THREE.Vector3).set(f.size.x, f.size.y, f.size.z);
    u.uVoxel!.value = f.cell;
    u.uOccupancy!.value = occ;
    (u.uOccupancyDims!.value as THREE.Vector3).set(f.bx, f.by, f.bz);
    u.uBlockSize!.value = f.cell * OCCUPANCY_BLOCK;
  }

  dispose(): void {
    this.texture?.dispose();
    this.occupancyTexture?.dispose();
    this.radiusLut.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
