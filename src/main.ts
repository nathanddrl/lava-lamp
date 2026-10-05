import { LampProfile, SIM_FIXED_DT, Simulation, WAX_PRESETS, DEFAULT_WAX_PARAMS, DEFAULT_PRESET, type PresetName } from './sim';
import { Stage, WebGL2UnavailableError, THEMES, THEME_NAMES, DEFAULT_THEME, type ThemeName } from './render';
import { ControlBar, createDebugPanel, showFatal, type LoopStats } from './ui';

/** Pas fixe de la physique (s). Indépendant du framerate d'affichage. */
const FIXED_DT = SIM_FIXED_DT;
/** Au-delà, on considère que l'onglet a été suspendu : on ne rattrape pas. */
const MAX_FRAME_DT = 0.1;
/** Garde-fou contre la spirale de la mort si un step devient trop coûteux. */
const MAX_STEPS_PER_FRAME = 12;

/**
 * Allumage : la cire part froide, tassée au fond ; l'ampoule monte en puissance et la
 * simulation tourne en accéléré le temps que le point chaud fonde (~45 s simulées).
 */
const IGNITION = {
  /** Durée réelle (s). */
  duration: 7,
  /** Vitesse maximale pendant l'allumage. */
  speed: 8,
  /** Montée de la vitesse, puis retour à ×1 (s, réelles). */
  rampUp: 1,
  rampDown: 1.5,
  /** Montée de la puissance de l'ampoule (s). */
  powerUp: 2.5,
};

const app = document.getElementById('app');
if (!app) throw new Error('#app introuvable');

const profile = new LampProfile();
const sim = new Simulation(profile);

function createStage(container: HTMLElement): Stage | null {
  try {
    return new Stage(container, profile, sim.wax);
  } catch (err) {
    if (err instanceof WebGL2UnavailableError) {
      showFatal(
        'WebGL2 n’est pas disponible',
        'Cette lampe à lave est calculée en temps réel par la carte graphique et demande WebGL2. ' +
          'Essayez un navigateur récent (Chrome, Edge, Firefox, Safari 15+) ou activez l’accélération matérielle.',
      );
    } else {
      console.warn(err);
      showFatal('La lampe n’a pas pu démarrer', 'Le rendu 3D a rencontré une erreur à l’initialisation.', {
        label: 'Recharger',
        run: () => location.reload(),
      });
    }
    return null;
  }
}

const createdStage = createStage(app);
if (createdStage) run(createdStage);

function run(stage: Stage): void {
  stage.renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    stage.renderer.setAnimationLoop(null);
    showFatal('La carte graphique a décroché', 'Le contexte WebGL a été perdu (pilote, mise en veille, trop d’onglets).', {
      label: 'Recharger',
      run: () => location.reload(),
    });
  });

  // ------------------------------------------------------------------ état de l'app
  const state = {
    theme: DEFAULT_THEME as ThemeName,
    mode: DEFAULT_PRESET as PresetName,
    /** Pause demandée par l'utilisateur (≠ onglet caché). */
    paused: false,
    /** Temps réel écoulé depuis le début de l'allumage, Infinity = terminé. */
    ignition: 0,
  };

  sim.reset('settled');
  stage.power = 0;

  function applyMode(name: PresetName, reset: boolean): void {
    state.mode = name;
    // Sans reset : les paramètres thermiques changent, la cire en place s'y adapte.
    Object.assign(sim.wax.params, DEFAULT_WAX_PARAMS, WAX_PRESETS[name]);
    if (reset) sim.reset();
  }

  const stats: LoopStats = {
    fps: 0,
    stepsPerFrame: 0,
    stepMs: 0,
    simTime: 0,
    realSpeed: 0,
    splatMs: 0,
    renderCpuMs: 0,
    gpuMs: 'n/d',
    quality: stage.quality.current.label,
  };

  const gui = createDebugPanel({
    simParams: sim.params,
    waxParams: sim.wax.params,
    stats,
    glass: stage.lamp.glassParams,
    updateGlass: stage.lamp.updateGlass,
    room: stage.room,
    post: stage.post.params,
    adaptive: stage.quality.params,
    waxView: stage.waxDebug.params,
    surface: stage.waxSurface.params,
    field: stage.waxSurface.field.params,
    halo: stage.halo.params,
    reset: () => sim.reset(),
    impulse: () => sim.impulse(),
    applyPreset: (name: PresetName) => {
      applyMode(name, true);
      bar.setMode(name);
    },
  });
  gui.domElement.classList.add('lava-debug-hidden');

  const bar = new ControlBar(document.body, {
    themes: THEME_NAMES.map((id) => ({ id, label: THEMES[id].label, wax: THEMES[id].waxColor, liquid: THEMES[id].liquidColor })),
    modes: [
      { id: 'calme', label: 'Calme', short: 'C' },
      { id: 'équilibré', label: 'Équilibré', short: 'É' },
      { id: 'agité', label: 'Agité', short: 'A' },
    ],
    theme: state.theme,
    mode: state.mode,
    onTheme: (id) => {
      state.theme = id as ThemeName;
      stage.setTheme(state.theme);
    },
    onMode: (id) => applyMode(id as PresetName, false),
    onPause: (paused) => setPaused(paused),
    onFullscreen: toggleFullscreen,
  });

  function setPaused(paused: boolean): void {
    state.paused = paused;
    sim.params.paused = paused;
    bar.setPaused(paused);
  }

  function toggleFullscreen(): void {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    // Ne pas détourner la saisie dans le panneau de debug.
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
    if (e.code === 'KeyD') gui.domElement.classList.toggle('lava-debug-hidden');
    else if (e.code === 'KeyF') toggleFullscreen();
    else if (e.code === 'Space' && target?.tagName !== 'BUTTON') {
      e.preventDefault();
      setPaused(!state.paused);
    }
  });

  // ------------------------------------------------------------------ boucle
  let accumulator = 0;
  let lastTime: number | null = null;
  let fpsFrames = 0;
  let fpsWindowStart = 0;
  let stepMsAvg = 0;
  let simTimeWindowStart = 0;

  function smoothstep(a: number, b: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /** Vitesse de la simulation et puissance de l'ampoule pendant l'allumage. */
  function ignitionStep(dt: number): number {
    if (state.ignition === Infinity) return 1;
    state.ignition += dt;
    const t = state.ignition;
    const { duration, speed, rampUp, rampDown, powerUp } = IGNITION;
    stage.power = smoothstep(0, powerUp, t);
    if (t >= duration) {
      state.ignition = Infinity;
      stage.power = 1;
      // La mesure de framerate de l'allumage (physique accélérée) ne vaut rien.
      stage.quality.resetWindow();
      return 1;
    }
    const up = smoothstep(0, rampUp, t);
    const down = 1 - smoothstep(duration - rampDown, duration, t);
    return 1 + (speed - 1) * up * down;
  }

  function frame(now: number): void {
    if (lastTime === null) {
      lastTime = now;
      fpsWindowStart = now;
    }
    const rawDt = (now - lastTime) / 1000;
    const frameDt = Math.min(rawDt, MAX_FRAME_DT);
    lastTime = now;

    const ignitionSpeed = state.paused ? 1 : ignitionStep(frameDt);
    if (!sim.params.paused) accumulator += frameDt * sim.params.timeScale * ignitionSpeed;

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

    stage.render(sim.wax, accumulator / FIXED_DT, frameDt, now / 1000);

    // Qualité adaptative, hors allumage (la physique accélérée fausse la mesure).
    if (state.ignition === Infinity && stage.quality.frame(rawDt)) {
      stage.applyQuality(stage.quality.current);
      stats.quality = stage.quality.current.label;
    }

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

  function start(): void {
    lastTime = null;
    stage.quality.resetWindow();
    stage.renderer.setAnimationLoop(frame);
  }

  // Onglet caché : on coupe la boucle (ni physique ni rendu), on reprend sans rattrapage.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stage.renderer.setAnimationLoop(null);
    else start();
  });
  if (!document.hidden) start();

  // Accès console en dev (et pour les captures automatisées) : `lava.sim`, `lava.stage`.
  if (import.meta.env.DEV) Object.assign(window, { lava: { sim, stage, stats, state } });

  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      stage.renderer.setAnimationLoop(null);
      gui.destroy();
      bar.dispose();
      stage.dispose();
    });
  }
}
