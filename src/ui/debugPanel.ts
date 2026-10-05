import GUI from 'lil-gui';
import type { SimulationParams } from '../sim/simulation';
import { DEFAULT_PRESET, WAX_PRESETS, type PresetName } from '../sim/presets';
import { MAX_PARTICLES, type WaxParams } from '../sim/waxSystem';
import type { DensityFieldParams } from '../render/densityField';
import type { WaxSurfaceParams } from '../render/waxSurfaceView';

/** Compteurs mis à jour par la boucle et affichés en lecture seule. */
export interface LoopStats {
  fps: number;
  stepsPerFrame: number;
  /** Temps CPU moyen d'un pas fixe de simulation, en ms. */
  stepMs: number;
  simTime: number;
  /** Vitesse réellement atteinte (temps simulé / temps réel). */
  realSpeed: number;
  /** Temps CPU du splatting du champ de densité, ms. */
  splatMs: number;
  /** Temps CPU de soumission du rendu, ms. */
  renderCpuMs: number;
  /** Temps GPU de la frame, ms ('n/d' sans EXT_disjoint_timer_query_webgl2). */
  gpuMs: string;
}

export interface DebugPanelTargets {
  simParams: SimulationParams;
  waxParams: WaxParams;
  stats: LoopStats;
  glassMaterial: { opacity: number };
  waxView: { visible: boolean; sphereRadius: number };
  surface: WaxSurfaceParams;
  field: DensityFieldParams;
  reset: () => void;
  impulse: () => void;
  applyPreset: (name: PresetName) => void;
}

export function createDebugPanel(t: DebugPanelTargets): GUI {
  const gui = new GUI({ title: 'Lava Lamp — debug' });
  const actions = { reset: t.reset, impulse: t.impulse, preset: DEFAULT_PRESET as PresetName };

  const sim = gui.addFolder('Simulation');
  sim.add(t.simParams, 'paused').name('pause');
  sim.add(t.simParams, 'timeScale', 0, 10, 0.1).name('vitesse');
  sim.add(actions, 'impulse').name('impulsion ↑');
  sim.add(actions, 'reset').name('reset');
  sim
    .add(actions, 'preset', Object.keys(WAX_PRESETS))
    .name('preset (reset)')
    .onChange((name: PresetName) => {
      t.applyPreset(name);
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    });

  const wax = gui.addFolder('Cire (Clavet 2005)');
  const w = t.waxParams;
  wax.add(w, 'particleCount', 50, MAX_PARTICLES, 10).name('particules (reset)').onFinishChange(t.reset);
  wax.add(w, 'interactionRadius', 0.05, 0.3, 0.005).name('rayon interaction h');
  wax.add(w, 'restDensity', 0.5, 15, 0.1).name('rest density ρ0');
  wax.add(w, 'stiffness', 0, 300, 1).name('k');
  wax.add(w, 'nearStiffness', 0, 1000, 5).name('k near');
  wax.add(w, 'cohesion', 0, 1, 0.01).name('cohésion');
  wax.add(w, 'viscosityLinear', 0, 200, 1).name('viscosité σ');
  wax.add(w, 'viscosityQuadratic', 0, 200, 1).name('viscosité β');
  wax.add(w, 'viscosityHotFactor', 0, 1, 0.01).name('viscosité cire chaude ×');
  wax.add(w, 'gravity', 0, 10, 0.05).name('gravité résiduelle');
  wax.add(w, 'drag', 0, 110, 0.5).name('traînée');
  wax.add(w, 'wallFriction', 0, 1, 0.01).name('friction paroi');
  wax.add(w, 'particleRadius', 0, 0.1, 0.005).name('rayon collision');
  wax.add(w, 'impulseStrength', 0, 30, 0.5).name('force impulsion');
  wax.add(w, 'maxSpeed', 0.5, 20, 0.5).name('vitesse max');
  wax.add(w, 'substeps', 1, 8, 1).name('sous-pas');

  const th = gui.addFolder('Thermique');
  th.add(w, 'heatRate', 0, 8, 0.05).name('chauffe');
  th.add(w, 'heatFalloff', 0.01, 0.5, 0.005).name('chauffe : hauteur');
  th.add(w, 'heatRadius', 0.02, 0.5, 0.005).name('chauffe : rayon');
  th.add(w, 'coolRate', 0, 0.5, 0.005).name('échange liquide');
  th.add(w, 'ambientBottom', 0, 1, 0.01).name('T ambiante fond');
  th.add(w, 'ambientMid', 0, 1, 0.01).name('T ambiante milieu');
  th.add(w, 'ambientTop', 0, 1, 0.01).name('T ambiante haut');
  th.add(w, 'ambientBottomHeight', 0, 0.5, 0.01).name('ambiance fond : hauteur');
  th.add(w, 'ambientTopStart', 0.5, 1, 0.01).name('ambiance haut : début');
  th.add(w, 'coolTopBoost', 0, 300, 1).name('échange haut ×');
  th.add(w, 'coolTopExponent', 1, 12, 0.5).name('échange haut exposant');
  th.add(w, 'wallCooling', 0, 50, 0.5).name('échange paroi ×');
  th.add(w, 'interiorCooling', 0, 1, 0.01).name('échange cœur (fraction)');
  th.add(w, 'conductivity', 0, 20, 0.1).name('conduction');
  th.add(w, 'buoyancy', 0, 100, 0.5).name('flottabilité');
  th.add(w, 'buoyancyMax', 0.5, 1000, 0.5).name('flottabilité max');
  th.add(w, 'neutralTemperature', 0, 1, 0.01).name('T neutre');
  th.add(w, 'meltHysteresis', 0, 0.8, 0.01).name('hystérésis fusion');
  th.add(w, 'meltDelay', 0, 6, 0.05).name('délai de fusion (s)');

  const render = gui.addFolder('Rendu');
  const s = t.surface;
  render.add(s, 'visible').name('surface cire');
  render.add(s, 'liquidVisible').name('liquide');
  render.add(t.waxView, 'visible').name('sphères debug');
  render.add(t.waxView, 'sphereRadius', 0.005, 0.12, 0.001).name('taille sphères');
  render.add(t.glassMaterial, 'opacity', 0, 1, 0.01).name('opacité verre');

  const field = render.addFolder('Champ de densité');
  field.add(s, 'threshold', 0.05, 1.5, 0.01).name('seuil');
  field.add(t.field, 'kernelRadius', 0.03, 0.2, 0.005).name('rayon du noyau');
  field.add(t.field, 'resolution', 24, 96, 4).name('résolution grille (x, z)');
  field.add(t.field, 'smoothingTime', 0, 0.2, 0.005).name('lissage temporel (s)');
  field.add(s, 'steps', 16, 256, 1).name('pas du raymarch');
  field.add(s, 'liquidSteps', 4, 64, 1).name('pas du liquide');

  const look = render.addFolder('Aspect');
  look.addColor(s, 'waxColor').name('cire froide');
  look.addColor(s, 'waxHotColor').name('cire chaude');
  look.addColor(s, 'waxDeepColor').name('cire en profondeur');
  look.addColor(s, 'liquidColor').name('liquide');
  look.add(s, 'liquidDensity', 0, 2, 0.01).name('densité liquide');
  look.add(s, 'bulbIntensity', 0, 6, 0.05).name('ampoule');
  look.add(s, 'subsurface', 0, 3, 0.01).name('subsurface');
  look.add(s, 'thicknessScale', 0, 40, 0.5).name('extinction cire');
  look.add(s, 'emission', 0, 2, 0.01).name('émission');
  look.add(s, 'wrap', 0, 1, 0.01).name('wrap lighting');
  look.add(s, 'fresnel', 0, 1, 0.01).name('fresnel');
  look.close();

  const stats = gui.addFolder('Stats');
  stats.add(t.stats, 'fps').name('fps').disable().listen();
  stats.add(t.stats, 'realSpeed').name('vitesse réelle ×').disable().listen();
  stats.add(t.stats, 'stepsPerFrame').name('steps / frame').disable().listen();
  stats.add(t.stats, 'stepMs').name('ms / step').disable().listen();
  stats.add(t.stats, 'splatMs').name('splatting CPU (ms)').disable().listen();
  stats.add(t.stats, 'renderCpuMs').name('rendu CPU (ms)').disable().listen();
  stats.add(t.stats, 'gpuMs').name('rendu GPU (ms)').disable().listen();
  stats.add(t.stats, 'simTime').name('temps simulé (s)').disable().listen();

  return gui;
}
