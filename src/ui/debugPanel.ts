import GUI from 'lil-gui';
import type { SimulationParams } from '../sim/simulation';
import { MAX_PARTICLES, type WaxParams } from '../sim/waxSystem';

/** Compteurs mis à jour par la boucle et affichés en lecture seule. */
export interface LoopStats {
  fps: number;
  stepsPerFrame: number;
  /** Temps CPU moyen d'un pas fixe de simulation, en ms. */
  stepMs: number;
  simTime: number;
}

export interface DebugPanelTargets {
  simParams: SimulationParams;
  waxParams: WaxParams;
  stats: LoopStats;
  glassMaterial: { opacity: number };
  waxView: { visible: boolean; sphereRadius: number };
  reset: () => void;
  impulse: () => void;
}

export function createDebugPanel(t: DebugPanelTargets): GUI {
  const gui = new GUI({ title: 'Lava Lamp — debug' });
  const actions = { reset: t.reset, impulse: t.impulse };

  const sim = gui.addFolder('Simulation');
  sim.add(t.simParams, 'paused').name('pause');
  sim.add(t.simParams, 'timeScale', 0, 4, 0.05).name('vitesse');
  sim.add(actions, 'impulse').name('impulsion ↑');
  sim.add(actions, 'reset').name('reset');

  const wax = gui.addFolder('Cire (Clavet 2005)');
  const w = t.waxParams;
  wax.add(w, 'particleCount', 50, MAX_PARTICLES, 10).name('particules (reset)').onFinishChange(t.reset);
  wax.add(w, 'interactionRadius', 0.05, 0.3, 0.005).name('rayon interaction h');
  wax.add(w, 'restDensity', 0.5, 15, 0.1).name('rest density ρ0');
  wax.add(w, 'stiffness', 0, 300, 1).name('k');
  wax.add(w, 'nearStiffness', 0, 1000, 5).name('k near');
  wax.add(w, 'viscosityLinear', 0, 200, 1).name('viscosité σ');
  wax.add(w, 'viscosityQuadratic', 0, 200, 1).name('viscosité β');
  wax.add(w, 'gravity', 0, 10, 0.05).name('gravité');
  wax.add(w, 'drag', 0, 10, 0.05).name('traînée');
  wax.add(w, 'wallFriction', 0, 1, 0.01).name('friction paroi');
  wax.add(w, 'particleRadius', 0, 0.1, 0.005).name('rayon collision');
  wax.add(w, 'impulseStrength', 0, 30, 0.5).name('force impulsion');
  wax.add(w, 'maxSpeed', 0.5, 20, 0.5).name('vitesse max');
  wax.add(w, 'substeps', 1, 8, 1).name('sous-pas');

  const render = gui.addFolder('Rendu');
  render.add(t.waxView, 'visible').name('sphères debug');
  render.add(t.waxView, 'sphereRadius', 0.005, 0.12, 0.001).name('taille sphères');
  render.add(t.glassMaterial, 'opacity', 0, 1, 0.01).name('opacité verre');

  const stats = gui.addFolder('Stats');
  stats.add(t.stats, 'fps').name('fps').disable().listen();
  stats.add(t.stats, 'stepsPerFrame').name('steps / frame').disable().listen();
  stats.add(t.stats, 'stepMs').name('ms / step').disable().listen();
  stats.add(t.stats, 'simTime').name('temps simulé (s)').disable().listen();

  return gui;
}
