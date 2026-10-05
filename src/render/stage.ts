import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LampProfile } from '../sim/lampProfile';
import type { WaxSystem } from '../sim/waxSystem';
import { FloorHalo } from './halo';
import { createLampView, type LampView } from './lamp';
import { GpuTimer } from './gpuTimer';
import { PostProcess } from './postprocess';
import { AdaptiveQuality, type QualityLevel } from './quality';
import { DEFAULT_THEME, ThemeBlender, THEMES, type ThemeName, type ThemeTarget } from './themes';
import { WaxDebugView } from './waxDebugView';
import { WaxSurfaceView } from './waxSurfaceView';

/** Levée quand le navigateur n'offre pas WebGL2 (ou que la création du contexte échoue). */
export class WebGL2UnavailableError extends Error {
  constructor() {
    super('WebGL2 indisponible');
    this.name = 'WebGL2UnavailableError';
  }
}

/** Réglages de la pièce (exposés dans le panneau). */
export interface RoomParams {
  /** Intensité des reflets de l'environnement (pièce sombre : faible). */
  environment: number;
  /** Lumière d'appoint (clé + ciel) : la lampe doit rester la source principale. */
  fill: number;
  /** Intensité de la lumière ponctuelle de l'ampoule sur le métal et le sol. */
  bulbLight: number;
}

export const DEFAULT_ROOM_PARAMS: RoomParams = {
  environment: 0.12,
  fill: 0.35,
  bulbLight: 1.6,
};

/** Orbite automatique de la caméra quand personne ne touche à la scène. */
export interface AutoOrbitParams {
  enabled: boolean;
  /** Inactivité avant que la caméra se mette à tourner (s). */
  delay: number;
  /** Vitesse de croisière, en tours par minute. */
  speed: number;
}

export const DEFAULT_AUTO_ORBIT_PARAMS: AutoOrbitParams = {
  enabled: true,
  delay: 1.5,
  // Un tour en deux minutes : on sent que ça bouge, sans que ça attire l'œil.
  speed: 0.5,
};

/** Constante de temps de la mise en vitesse de l'orbite (s) : départ sans à-coup. */
const AUTO_ORBIT_EASE = 1.2;

/** Hauteur de la lampe + marge de cadrage, et rayon apparent à garder dans le champ. */
const FRAME_MARGIN = 1.3;
const FRAME_RADIUS = 1.15;
/** Point visé sous le milieu de la lampe : elle remonte à l'écran, au-dessus de la barre. */
const TARGET_DROP = 0.3;

/**
 * Scène, caméra, contrôles, lumières, post-process et renderer. Ne connaît la
 * simulation qu'à travers le profil de la lampe et les buffers de la cire.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly lamp: LampView;
  readonly waxDebug = new WaxDebugView();
  readonly waxSurface: WaxSurfaceView;
  readonly halo: FloorHalo;
  readonly post: PostProcess;
  readonly quality: AdaptiveQuality;
  readonly themes = new ThemeBlender();
  readonly room: RoomParams = { ...DEFAULT_ROOM_PARAMS };
  readonly autoOrbit: AutoOrbitParams = { ...DEFAULT_AUTO_ORBIT_PARAMS };
  /** Temps GPU de toute la frame (scène + post-process), ms. */
  readonly gpuTimer: GpuTimer;
  /** Temps CPU de soumission du rendu, ms. */
  renderCpuMs = 0;
  /** Puissance de la lampe, 0 = éteinte, 1 = régime (allumage). */
  power = 1;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly profile: LampProfile;
  private readonly environment: THREE.Texture;
  private readonly hemi: THREE.HemisphereLight;
  private readonly key: THREE.DirectionalLight;
  private readonly rim: THREE.DirectionalLight;
  private readonly bulb: THREE.PointLight;
  private readonly floor: THREE.Mesh;
  private readonly themeState: ThemeTarget;
  private pixelRatio = 1;
  /** Temps écoulé depuis la dernière manipulation de la caméra (s). */
  private idleTime = 0;
  /** L'utilisateur tient la caméra (glisser, pincer). */
  private interacting = false;
  /** Fraction [0, 1] de la vitesse d'orbite atteinte (montée progressive). */
  private orbitBlend = 0;

  constructor(container: HTMLElement, profile: LampProfile, wax: WaxSystem) {
    this.container = container;
    this.profile = profile;

    const canvas = document.createElement('canvas');
    // Test explicite : Three.js retomberait sinon sur une erreur peu lisible.
    const gl = canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new WebGL2UnavailableError();
    // L'antialiasing est fait par le MSAA de la cible HDR du post-process.
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    // Pièce sombre : fond presque noir, le brouillard fond le bord du sol.
    const dark = new THREE.Color(0x030204);
    this.scene.background = dark;
    this.scene.fog = new THREE.Fog(dark, 9, 22);

    // Reflets d'environnement générés (pas de fichier HDR) : RoomEnvironment → PMREM.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment;

    const center = profile.totalHeight * 0.5 - TARGET_DROP;
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 100);
    this.camera.position.set(4.2, center + 1.0, 6.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, center, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Pas de pan : la cible reste sur l'axe de la lampe.
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 16;
    // Ne jamais passer sous le sol (légèrement au-dessus de l'horizon).
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = Math.PI * 0.5 - 0.04;
    this.controls.update();
    // Orbite automatique : coupée net dès qu'on attrape la caméra, relancée après
    // `autoOrbit.delay` secondes d'inactivité (zoom molette compris).
    const grab = (): void => {
      this.interacting = true;
      this.idleTime = 0;
      this.orbitBlend = 0;
    };
    this.controls.addEventListener('start', grab);
    this.controls.addEventListener('end', () => {
      this.interacting = false;
      this.idleTime = 0;
    });
    // Respect du réglage système « réduire les animations ».
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) this.autoOrbit.enabled = false;

    this.hemi = new THREE.HemisphereLight(0x8090b0, 0x1a1210, 1);
    this.key = new THREE.DirectionalLight(0xffffff, 1);
    this.key.position.set(4, 7, 5);
    this.rim = new THREE.DirectionalLight(0x6070ff, 1);
    this.rim.position.set(-5, 3, -4);
    // Ampoule dans le socle, sous le col : éclaire le sol et le dessous du métal, sans
    // laisser de reflet ponctuel sur le verre (la lueur du liquide est dans le volume).
    this.bulb = new THREE.PointLight(0xffb070, 1, 7, 2);
    this.bulb.position.set(0, profile.glassBottom - 0.2, 0);
    this.scene.add(this.hemi, this.key, this.rim, this.bulb);

    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 96),
      new THREE.MeshStandardMaterial({ color: 0x17141a, roughness: 0.62, metalness: 0 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.name = 'floor';
    this.scene.add(this.floor);
    this.halo = new FloorHalo(profile.dims.baseBottomRadius);
    this.scene.add(this.halo.mesh);

    this.lamp = createLampView(profile);
    this.scene.add(this.lamp.group);
    this.scene.add(this.waxDebug.mesh);
    this.waxSurface = new WaxSurfaceView(profile, wax, this.renderer);
    this.scene.add(this.waxSurface.volumeMesh);

    // Écrans tactiles / petits GPU : on part un cran plus bas.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.quality = new AdaptiveQuality(coarse ? 3 : 1);
    this.post = new PostProcess(this.renderer, this.scene, this.camera, this.quality.current.samples);
    this.gpuTimer = new GpuTimer(gl);

    this.themeState = { ...this.waxSurface.params, haloColor: THEMES[DEFAULT_THEME].haloColor };
    this.setTheme(DEFAULT_THEME, true);

    this.applyQuality(this.quality.current);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.frameLamp();
  }

  /** Change de thème, en fondu (ou immédiatement). */
  setTheme(name: ThemeName, instant = false): void {
    if (instant) this.themes.apply(this.themeState, name);
    else this.themes.start(this.themeState, name);
    this.copyTheme();
  }

  private copyTheme(): void {
    const s = this.waxSurface.params;
    const t = this.themeState;
    s.waxColor = t.waxColor;
    s.waxHotColor = t.waxHotColor;
    s.waxDeepColor = t.waxDeepColor;
    s.liquidColor = t.liquidColor;
    s.bulbColor = t.bulbColor;
    s.liquidDensity = t.liquidDensity;
  }

  /** Applique un niveau de qualité (pixel ratio, grille, pas, MSAA, bloom). */
  applyQuality(level: QualityLevel): void {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, level.maxPixelRatio);
    this.waxSurface.field.params.resolution = level.gridResolution;
    this.waxSurface.params.steps = level.steps;
    this.post.setSamples(level.samples);
    this.post.params.bloom = level.bloom;
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, this.pixelRatio);
    const portraitChange = (this.camera.aspect >= 1) !== (w / h >= 1);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (portraitChange) this.frameLamp();
  }

  /**
   * Recule la caméra pour que toute la lampe tienne à l'écran, en portrait comme en
   * paysage (téléphone vertical : c'est la largeur qui contraint).
   */
  frameLamp(): void {
    const halfV = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
    const height = this.profile.totalHeight * FRAME_MARGIN;
    const dist = Math.max(height / 2 / Math.tan(halfV), FRAME_RADIUS / Math.tan(halfH));
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.maxDistance = Math.max(16, dist * 1.5);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
  }

  /**
   * @param alpha fraction [0, 1) du pas fixe écoulée depuis le dernier step :
   * le rendu interpole entre les deux derniers états de la simulation.
   * @param frameDt temps réel écoulé depuis la frame précédente.
   * @param time temps réel total (s), pour le grain.
   */
  render(wax: WaxSystem, alpha: number, frameDt: number, time: number): void {
    if (this.themes.transitioning) {
      this.themes.update(this.themeState, frameDt);
      this.copyTheme();
    }
    const p = this.power;
    const r = this.room;
    this.scene.environmentIntensity = r.environment;
    this.hemi.intensity = 0.15 * r.fill;
    this.key.intensity = 0.8 * r.fill;
    this.rim.intensity = 0.4 * r.fill;
    this.bulb.color.set(this.waxSurface.params.bulbColor);
    this.bulb.intensity = r.bulbLight * p;
    this.halo.update(this.themeState.haloColor, p);

    this.waxSurface.power = p;
    this.waxDebug.update(wax, alpha);
    this.waxSurface.update(wax, alpha, frameDt);
    this.updateAutoOrbit(frameDt);
    this.controls.update(frameDt);

    const t0 = performance.now();
    this.gpuTimer.begin();
    this.post.render(time, this.scene, this.camera);
    this.gpuTimer.end();
    const ms = performance.now() - t0;
    this.renderCpuMs += (ms - this.renderCpuMs) * 0.05;
  }

  /** Rotation lente autour de la lampe après un temps d'inactivité, avec mise en vitesse douce. */
  private updateAutoOrbit(dt: number): void {
    const o = this.autoOrbit;
    if (!this.interacting) this.idleTime += dt;
    const active = o.enabled && !this.interacting && this.idleTime >= o.delay;
    const target = active ? 1 : 0;
    this.orbitBlend += (target - this.orbitBlend) * (1 - Math.exp(-dt / AUTO_ORBIT_EASE));
    // OrbitControls : autoRotateSpeed 1 = un tour par minute quand update() reçoit le dt.
    this.controls.autoRotate = this.orbitBlend > 1e-3;
    this.controls.autoRotateSpeed = o.speed * this.orbitBlend;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.lamp.dispose();
    this.waxDebug.dispose();
    this.waxSurface.dispose();
    this.halo.dispose();
    this.post.dispose();
    this.gpuTimer.dispose();
    this.environment.dispose();
    this.floor.geometry.dispose();
    (this.floor.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
