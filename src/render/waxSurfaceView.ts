import * as THREE from 'three';
import type { LampProfile } from '../sim/lampProfile';
import type { WaxSystem } from '../sim/waxSystem';
import { DensityField, OCCUPANCY_BLOCK, clavetReferenceDensity } from './densityField';
import volumeVert from './shaders/volume.vert.glsl?raw';
import volumeCommon from './shaders/volumeCommon.glsl?raw';
import waxFrag from './shaders/wax.frag.glsl?raw';
import liquidFrag from './shaders/liquid.frag.glsl?raw';

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
  liquidSteps: number;
  waxColor: string;
  waxHotColor: string;
  waxDeepColor: string;
  liquidColor: string;
  /** Densité optique du liquide (1/unité). */
  liquidDensity: number;
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
  liquidSteps: 24,
  waxColor: '#d8381c',
  waxHotColor: '#ff7a1e',
  waxDeepColor: '#ff5a1a',
  liquidColor: '#ffb347',
  liquidDensity: 0.35,
  bulbIntensity: 2.2,
  subsurface: 0.9,
  thicknessScale: 9,
  emission: 0.35,
  wrap: 0.6,
  fresnel: 0.35,
};

/**
 * Surface de la cire : champ de densité splatté sur CPU (DensityField), uploadé en
 * texture 3D, raymarché dans le volume intérieur du verre.
 *
 *  - `waxMesh` (passe opaque) : faces arrière du volume intérieur ; le fragment
 *    cherche l'isosurface, écrit couleur + gl_FragDepth, ou se défausse.
 *  - `liquidMesh` (passe transparente, avant le verre) : mêmes faces arrière, teinte
 *    du liquide accumulée le long du rayon ; masqué par la profondeur de la cire.
 */
export class WaxSurfaceView {
  readonly params: WaxSurfaceParams = { ...DEFAULT_WAX_SURFACE_PARAMS };
  readonly field: DensityField;
  readonly waxMesh: THREE.Mesh;
  readonly liquidMesh: THREE.Mesh;
  /** Temps CPU moyen du splatting + préparation de l'upload (ms). */
  splatMs = 0;

  private readonly geometry: THREE.LatheGeometry;
  private readonly waxMaterial: THREE.ShaderMaterial;
  private readonly liquidMaterial: THREE.ShaderMaterial;
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
      uLiquidSteps: { value: 0 },
      uRadiusLut: { value: this.radiusLut },
      uYMin: { value: profile.yMin },
      uYMax: { value: profile.yMax },
      uMaxRadius: { value: maxRadius },
      uWallSoftness: { value: 0.025 },
      uLiquidAbsorption: { value: new THREE.Vector3() },
      uLiquidScatter: { value: new THREE.Color() },
      // L'ampoule est dans le socle, sous le fond du verre.
      uBulbPosition: { value: new THREE.Vector3(0, profile.glassBottom - 0.12, 0) },
      uBulbColor: { value: new THREE.Color(1.0, 0.62, 0.3) },
      uBulbIntensity: { value: 0 },
      uLiquidGlowHeight: { value: 0.6 },
      uAmbientColor: { value: new THREE.Color(0.05, 0.05, 0.07) },
      uWaxColor: { value: new THREE.Color() },
      uWaxHotColor: { value: new THREE.Color() },
      uWaxDeepColor: { value: new THREE.Color() },
      uKeyDirection: { value: key },
      uKeyColor: { value: new THREE.Color(0.55, 0.53, 0.5) },
      uRimDirection: { value: rim },
      uRimColor: { value: new THREE.Color(0.12, 0.14, 0.3) },
      uWrap: { value: 0 },
      uSubsurface: { value: 0 },
      uThicknessScale: { value: 0 },
      uEmission: { value: 0 },
      uBulbReach: { value: 0.35 },
      uFresnel: { value: 0 },
    };

    this.waxMaterial = new THREE.ShaderMaterial({
      name: 'wax-surface',
      uniforms: this.uniforms,
      vertexShader: volumeVert,
      fragmentShader: `${volumeCommon}\n${waxFrag}`,
      side: THREE.BackSide,
    });
    this.waxMesh = new THREE.Mesh(this.geometry, this.waxMaterial);
    this.waxMesh.name = 'wax-surface';

    this.liquidMaterial = new THREE.ShaderMaterial({
      name: 'liquid',
      uniforms: this.uniforms,
      vertexShader: volumeVert,
      fragmentShader: `${volumeCommon}\n${liquidFrag}`,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.liquidMesh = new THREE.Mesh(this.geometry, this.liquidMaterial);
    this.liquidMesh.name = 'liquid';
    // Après les opaques (la cire a écrit sa profondeur), avant le verre (renderOrder 10).
    this.liquidMesh.renderOrder = 5;
  }

  /** Splatte les particules (interpolées) dans le champ et prépare l'upload. */
  update(wax: WaxSystem, alpha: number, frameDt: number): void {
    const p = this.params;
    this.waxMesh.visible = p.visible;
    this.liquidMesh.visible = p.liquidVisible;
    if (!p.visible) return;

    const t0 = performance.now();
    const field = this.field;
    field.update(wax.positions, wax.previousStepPositions, wax.temperatures, wax.count, alpha, frameDt);
    if (field.version !== this.textureVersion) this.recreateTexture();
    this.texture!.needsUpdate = true;
    this.occupancyTexture!.needsUpdate = true;
    const ms = performance.now() - t0;
    this.splatMs += (ms - this.splatMs) * 0.05;

    const u = this.uniforms;
    u.uThreshold!.value = p.threshold;
    u.uSteps!.value = Math.round(p.steps);
    u.uLiquidSteps!.value = Math.round(p.liquidSteps);
    (u.uWaxColor!.value as THREE.Color).set(p.waxColor);
    (u.uWaxHotColor!.value as THREE.Color).set(p.waxHotColor);
    (u.uWaxDeepColor!.value as THREE.Color).set(p.waxDeepColor);
    const liquid = u.uLiquidScatter!.value as THREE.Color;
    liquid.set(p.liquidColor);
    // Le liquide absorbe le complémentaire de sa couleur : il teinte ce qu'on voit à travers.
    (u.uLiquidAbsorption!.value as THREE.Vector3).set(
      p.liquidDensity * (0.15 + 1 - liquid.r),
      p.liquidDensity * (0.15 + 1 - liquid.g),
      p.liquidDensity * (0.15 + 1 - liquid.b),
    );
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
    this.waxMaterial.dispose();
    this.liquidMaterial.dispose();
  }
}
