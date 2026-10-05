import type { ContainerShape } from './lampProfile';
import { DEFAULT_WAX_PARAMS, WaxSystem, type WaxLayout, type WaxParams } from './waxSystem';

export interface SimulationParams {
  /** Multiplicateur appliqué au temps réel avant l'accumulateur. */
  timeScale: number;
  paused: boolean;
}

/**
 * Point d'entrée de la physique. Avance la cire à pas fixe. Ne dépend jamais
 * de Three.js : le rendu lit `wax.positions` / `wax.previousStepPositions`.
 */
export class Simulation {
  readonly container: ContainerShape;
  readonly params: SimulationParams = { timeScale: 1, paused: false };
  readonly wax: WaxSystem;
  /** Temps simulé cumulé, en secondes. */
  time = 0;
  stepCount = 0;

  constructor(container: ContainerShape, waxParams: Partial<WaxParams> = {}) {
    this.container = container;
    this.wax = new WaxSystem(container, { ...DEFAULT_WAX_PARAMS, ...waxParams });
  }

  /** Avance la simulation d'un pas fixe `dt` (secondes). */
  step(dt: number): void {
    this.wax.step(dt);
    this.time += dt;
    this.stepCount++;
  }

  reset(layout: WaxLayout = 'cloud'): void {
    this.wax.reset(layout);
    this.time = 0;
    this.stepCount = 0;
  }

  impulse(): void {
    this.wax.impulse();
  }
}
