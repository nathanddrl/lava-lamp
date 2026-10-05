import { LampProfile, SIM_FIXED_DT, Simulation, WAX_PRESETS, DEFAULT_WAX_PARAMS, type PresetName } from './sim';
import { Stage } from './render';
import { createDebugPanel, type LoopStats } from './ui';

/** Pas fixe de la physique (s). Indépendant du framerate d'affichage. */
const FIXED_DT = SIM_FIXED_DT;
/** Au-delà, on considère que l'onglet a été suspendu : on ne rattrape pas. */
const MAX_FRAME_DT = 0.1;
/** Garde-fou contre la spirale de la mort si un step devient trop coûteux. */
const MAX_STEPS_PER_FRAME = 12;

const app = document.getElementById('app');
if (!app) throw new Error('#app introuvable');

const profile = new LampProfile();
const sim = new Simulation(profile);
const stage = new Stage(app, profile, sim.wax);

const stats: LoopStats = {
  fps: 0,
  stepsPerFrame: 0,
  stepMs: 0,
  simTime: 0,
  realSpeed: 0,
  splatMs: 0,
  renderCpuMs: 0,
  gpuMs: 'n/d',
};
const gui = createDebugPanel({
  simParams: sim.params,
  waxParams: sim.wax.params,
  stats,
  glassMaterial: stage.lamp.glassMaterial,
  waxView: stage.waxDebug.params,
  surface: stage.waxSurface.params,
  field: stage.waxSurface.field.params,
  reset: () => sim.reset(),
  impulse: () => sim.impulse(),
  applyPreset: (name: PresetName) => {
    Object.assign(sim.wax.params, DEFAULT_WAX_PARAMS, WAX_PRESETS[name]);
    sim.reset();
  },
});

let accumulator = 0;
let lastTime: number | null = null;
let fpsFrames = 0;
let fpsWindowStart = 0;
let stepMsAvg = 0;
let simTimeWindowStart = 0;

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

  stage.render(sim.wax, accumulator / FIXED_DT, frameDt);

  fpsFrames++;
  if (now - fpsWindowStart >= 500) {
    stats.fps = Math.round((fpsFrames * 1000) / (now - fpsWindowStart));
    // Vitesse effectivement atteinte : plafonnée par le coût CPU de la physique.
    stats.realSpeed = Math.round(((sim.time - simTimeWindowStart) * 1000 * 10) / (now - fpsWindowStart)) / 10;
    simTimeWindowStart = sim.time;
    fpsFrames = 0;
    fpsWindowStart = now;
    stats.stepMs = Math.round(stepMsAvg * 100) / 100;
    stats.splatMs = Math.round(stage.waxSurface.splatMs * 100) / 100;
    stats.renderCpuMs = Math.round(stage.renderCpuMs * 100) / 100;
    const gpu = stage.gpuTimer.ms;
    stats.gpuMs = Number.isNaN(gpu) ? 'n/d' : (Math.round(gpu * 100) / 100).toString();
  }
  stats.stepsPerFrame = steps;
  stats.simTime = Math.round(sim.time * 100) / 100;
}

stage.renderer.setAnimationLoop(frame);

// Accès console en dev (et pour les captures automatisées) : `lava.sim`, `lava.stage`.
if (import.meta.env.DEV) Object.assign(window, { lava: { sim, stage, stats } });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    stage.renderer.setAnimationLoop(null);
    gui.destroy();
    stage.dispose();
  });
}
