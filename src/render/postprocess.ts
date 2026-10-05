import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import finishVert from './shaders/finish.vert.glsl?raw';
import finishFrag from './shaders/finish.frag.glsl?raw';

export interface PostParams {
  enabled: boolean;
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  /** Luminance linéaire (avant tone mapping) au-dessus de laquelle ça diffuse. */
  bloomThreshold: number;
  exposure: number;
  vignette: number;
  grain: number;
}

export const DEFAULT_POST_PARAMS: PostParams = {
  enabled: true,
  bloom: true,
  bloomStrength: 0.55,
  bloomRadius: 0.55,
  bloomThreshold: 0.75,
  exposure: 1.05,
  vignette: 0.45,
  grain: 0.03,
};

/**
 * Chaîne de post-process : rendu HDR (demi-flottants, MSAA) → bloom seuillé (n'attrape
 * que l'émissif : cire près de l'ampoule, liquide éclairé) → tone mapping ACES + sRGB
 * (OutputPass) → vignette et grain en espace d'affichage.
 */
export class PostProcess {
  readonly params: PostParams = { ...DEFAULT_POST_PARAMS };
  readonly composer: EffectComposer;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly bloom: UnrealBloomPass;
  private readonly finish: ShaderPass;
  private samples: number;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, samples = 4) {
    this.renderer = renderer;
    this.samples = samples;
    this.composer = new EffectComposer(renderer, this.createTarget(samples));
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0, 0, 0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(
      new THREE.ShaderMaterial({
        name: 'finish',
        uniforms: {
          tDiffuse: { value: null },
          uVignette: { value: 0 },
          uGrain: { value: 0 },
          uTime: { value: 0 },
          uAspect: { value: new THREE.Vector2(1, 1) },
        },
        vertexShader: finishVert,
        fragmentShader: finishFrag,
      }),
    );
    this.composer.addPass(this.finish);
  }

  private createTarget(samples: number): THREE.WebGLRenderTarget {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples,
    });
  }

  /** Change le MSAA de la cible HDR (recrée le composer en interne). */
  setSamples(samples: number): void {
    if (samples === this.samples) return;
    this.samples = samples;
    this.composer.reset(this.createTarget(samples));
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    (this.finish.uniforms.uAspect!.value as THREE.Vector2).set(width / Math.max(1, height), 1);
  }

  render(time: number, scene: THREE.Scene, camera: THREE.Camera): void {
    const p = this.params;
    this.renderer.toneMappingExposure = p.exposure;
    if (!p.enabled) {
      // Sans composer : tone mapping appliqué par le renderer, directement à l'écran.
      this.renderer.setRenderTarget(null);
      this.renderer.render(scene, camera);
      return;
    }
    this.bloom.enabled = p.bloom && p.bloomStrength > 0;
    this.bloom.strength = p.bloomStrength;
    this.bloom.radius = p.bloomRadius;
    this.bloom.threshold = p.bloomThreshold;
    const u = this.finish.uniforms;
    u.uVignette!.value = p.vignette;
    u.uGrain!.value = p.grain;
    u.uTime!.value = time;
    this.composer.render();
  }

  dispose(): void {
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.bloom.dispose();
    this.finish.material.dispose();
  }
}
