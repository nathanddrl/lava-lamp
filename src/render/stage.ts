import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LampProfile } from '../sim/lampProfile';
import { createLampView, type LampView } from './lamp';

/**
 * Scène, caméra, contrôles, lumières et renderer. Ne connaît la simulation
 * qu'à travers le profil de la lampe (et, plus tard, un buffer de particules).
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly lamp: LampView;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, profile: LampProfile) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x07060a);
    // Le brouillard fond le bord du sol dans le fond.
    this.scene.fog = new THREE.Fog(0x07060a, 15, 30);

    const center = profile.totalHeight * 0.5;
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 100);
    this.camera.position.set(4.2, center + 1.2, 6.2);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, center, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // Pas de pan : la cible reste sur l'axe de la lampe.
    this.controls.enablePan = false;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 14;
    // Ne jamais passer sous le sol (légèrement au-dessus de l'horizon).
    this.controls.minPolarAngle = 0.05;
    this.controls.maxPolarAngle = Math.PI * 0.5 - 0.04;
    this.controls.update();

    this.addLights(profile);
    this.addFloor();

    this.lamp = createLampView(profile);
    this.scene.add(this.lamp.group);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  private addLights(profile: LampProfile): void {
    this.scene.add(new THREE.HemisphereLight(0x8090b0, 0x1a1210, 0.6));

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(4, 7, 5);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x6070ff, 0.6);
    rim.position.set(-5, 3, -4);
    this.scene.add(rim);

    // Ampoule chaude dans le socle : future source de chaleur de la cire.
    const bulb = new THREE.PointLight(0xff8a3c, 6, 4, 2);
    bulb.position.set(0, profile.glassBottom + 0.15, 0);
    this.scene.add(bulb);
  }

  private addFloor(): void {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(12, 64),
      new THREE.MeshStandardMaterial({ color: 0x121016, roughness: 0.9, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.name = 'floor';
    this.scene.add(floor);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param _alpha fraction [0, 1) du pas fixe écoulée depuis le dernier step,
   * pour interpoler l'état de la simulation (inutilisé tant qu'il n'y a pas de particules).
   */
  render(_alpha: number): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.lamp.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
