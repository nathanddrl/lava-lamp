import { LampProfile, Simulation } from './sim';
import { Stage } from './render';
import { createDebugPanel, type LoopStats } from './ui';

/** Pas fixe de la physique (s). Indépendant du framerate d'affichage. */
const FIXED_DT = 1 / 120;
/** Au-delà, on considère que l'onglet a été suspendu : on ne rattrape pas. */
const MAX_FRAME_DT = 0.1;
/** Garde-fou contre la spirale de la mort si un step devient trop coûteux. */
const MAX_STEPS_PER_FRAME = 8;

const app = document.getElementById('app');
if (!app) throw new Error('#app introuvable');

const profile = new LampProfile();
const sim = new Simulation(profile);
const stage = new Stage(app, profile);

const stats: LoopStats = { fps: 0, stepsPerFrame: 0, stepMs: 0, simTime: 0 };
const gui = createDebugPanel({
  simParams: sim.params,
  waxParams: sim.wax.params,
  stats,
  glassMaterial: stage.lamp.glassMaterial,
  waxView: stage.waxDebug.params,
  reset: () => sim.reset(),
  impulse: () => sim.impulse(),
});

let accumulator = 0;
let lastTime: number | null = null;
let fpsFrames = 0;
let fpsWindowStart = 0;
let stepMsAvg = 0;

function frame(now: number): void {
  if (lastTime === null) {
    lastTime = now;
    fpsWindowStart = now;
  }
  const frameDt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT);
  lastTime = now;

  if (!sim.params.paused) accumulator += frameDt * sim.params.timeScale;

  let steps = 0;
  const simStart = performance.now();
  while (accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
    sim.step(FIXED_DT);
    accumulator -= FIXED_DT;
    steps++;
  }
  if (steps > 0) {
    const ms = (performance.now() - simStart) / steps;
    stepMsAvg += (ms - stepMsAvg) * 0.05;
  }
  // Si on n'a pas pu rattraper, on abandonne le retard plutôt que de l'accumuler.
  if (steps === MAX_STEPS_PER_FRAME) accumulator = Math.min(accumulator, FIXED_DT);

  stage.render(sim.wax, accumulator / FIXED_DT);

  fpsFrames++;
  if (now - fpsWindowStart >= 500) {
    stats.fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
    fpsFrames = 0;
    fpsWindowStart = now;
    stats.stepMs = Math.round(stepMsAvg * 100) / 100;
  }
  stats.stepsPerFrame = steps;
  stats.simTime = Math.round(sim.time * 100) / 100;
}

stage.renderer.setAnimationLoop(frame);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stage.renderer.setAnimationLoop(null);
    gui.destroy();
    stage.dispose();
  });
}
