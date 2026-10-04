import type { ContainerShape } from './lampProfile';

export interface SimulationParams {
  /** Multiplicateur appliqué au temps réel avant l'accumulateur. */
  timeScale: number;
  paused: boolean;
}

/**
 * Point d'entrée de la physique. Pour l'instant une coquille : elle avance le
 * temps à pas fixe. Les particules (cohésion, température, flottabilité)
 * viendront ici, sans jamais importer Three.js.
 */
export class Simulation {
  readonly container: ContainerShape;
  readonly params: SimulationParams = { timeScale: 1, paused: false };
  /** Temps simulé cumulé, en secondes. */
  time = 0;
  stepCount = 0;

  constructor(container: ContainerShape) {
    this.container = container;
  }

  /** Avance la simulation d'un pas fixe `dt` (secondes). */
  step(dt: number): void {
    this.time += dt;
    this.stepCount++;
  }
}
