import GUI from 'lil-gui';
import type { SimulationParams } from '../sim/simulation';

/** Compteurs mis à jour par la boucle et affichés en lecture seule. */
export interface LoopStats {
  fps: number;
  stepsPerFrame: number;
  simTime: number;
}

export interface DebugPanelTargets {
  simParams: SimulationParams;
  stats: LoopStats;
  glassMaterial: { opacity: number };
}

export function createDebugPanel(targets: DebugPanelTargets): GUI {
  const gui = new GUI({ title: 'Lava Lamp — debug' });

  const sim = gui.addFolder('Simulation');
  sim.add(targets.simParams, 'paused').name('pause');
  sim.add(targets.simParams, 'timeScale', 0, 4, 0.05).name('vitesse');

  const render = gui.addFolder('Rendu');
  render.add(targets.glassMaterial, 'opacity', 0, 1, 0.01).name('opacité verre');

  const stats = gui.addFolder('Stats');
  stats.add(targets.stats, 'fps').name('fps').disable().listen();
  stats.add(targets.stats, 'stepsPerFrame').name('steps / frame').disable().listen();
  stats.add(targets.stats, 'simTime').name('temps simulé (s)').disable().listen();

  return gui;
}
