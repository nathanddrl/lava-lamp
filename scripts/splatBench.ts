/**
 * Banc du champ de densité de la cire (étape 4), headless :
 *  - coût CPU de `DensityField.update` (splatting + lissage + occupation) ;
 *  - valeurs du champ aux particules (le cœur de la cire doit valoir ≈ 1) ;
 *  - scintillement : voxels qui franchissent le seuil puis reviennent dès la frame
 *    suivante (aller-retour), rapportés aux voxels de surface, avec la boucle réelle
 *    (pas fixe 1/60 s, affichage à `--hz`, interpolation alpha), avec et sans lissage
 *    temporel. Le mouvement normal de la surface donne des bascules, pas d'allers-retours ;
 *  - part des blocs d'occupation non vides (ce que le raymarch ne peut pas sauter).
 *
 * `--jitter j` : durée de frame tirée dans (1 ± j)/hz, comme un rAF réel (le cas
 * à 60 Hz est le plus dur : 0 ou 2 pas fixes certaines frames).
 *
 *   npm run bench:splat -- [--warmup 60] [--frames 600] [--hz 144] [--jitter 0.15] [--resolution 48]
 *                          [--kernel 0.085] [--threshold 0.5]
 */
import { DEFAULT_WAX_PARAMS, LampProfile, SIM_FIXED_DT, Simulation, mulberry32 } from '../src/sim';
import { DEFAULT_DENSITY_FIELD_PARAMS, DensityField, clavetReferenceDensity } from '../src/render/densityField';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const warmup = Number(arg('warmup') ?? 60);
const frames = Number(arg('frames') ?? 600);
const hz = Number(arg('hz') ?? 144);
const jitter = Number(arg('jitter') ?? 0.15);
const threshold = Number(arg('threshold') ?? 0.5);
const resolution = Number(arg('resolution') ?? DEFAULT_DENSITY_FIELD_PARAMS.resolution);
const kernelRadius = Number(arg('kernel') ?? DEFAULT_DENSITY_FIELD_PARAMS.kernelRadius);

const profile = new LampProfile();
let maxRadius = 0;
for (const p of profile.innerProfile(256)) maxRadius = Math.max(maxRadius, p.r);
const n0 = clavetReferenceDensity(DEFAULT_WAX_PARAMS.restDensity, DEFAULT_WAX_PARAMS.interactionRadius);

function quantiles(xs: number[], digits: number): string {
  const s = xs.slice().sort((a, b) => a - b);
  const q = (p: number) => s[Math.floor(p * (s.length - 1))]!.toFixed(digits);
  return `médiane ${q(0.5)}  p95 ${q(0.95)}  max ${q(1)}`;
}

function run(smoothingTime: number): void {
  const sim = new Simulation(profile);
  const wax = sim.wax;
  const field = new DensityField({ radius: maxRadius, yMin: profile.yMin, yMax: profile.yMax }, n0, {
    resolution,
    kernelRadius,
    smoothingTime,
  });
  for (let t = 0; t < warmup; t += SIM_FIXED_DT) sim.step(SIM_FIXED_DT);
  sim.step(SIM_FIXED_DT);

  const nVox = field.nx * field.ny * field.nz;
  // État au seuil des trois dernières frames (bits 0, 1, 2 = frames f, f − 1, f − 2).
  const history = new Uint8Array(nVox);
  const settle = 30; // frames ignorées : le champ lissé part de zéro
  const times: number[] = [];
  const flipRatios: number[] = [];
  let occupied = 0;
  const rand = mulberry32(7);
  let acc = 0;
  for (let f = 0; f < frames; f++) {
    const frameDt = (1 + jitter * (2 * rand() - 1)) / hz;
    acc += frameDt;
    while (acc >= SIM_FIXED_DT) {
      sim.step(SIM_FIXED_DT);
      acc -= SIM_FIXED_DT;
    }
    const t0 = performance.now();
    field.update(wax.positions, wax.previousStepPositions, wax.temperatures, wax.count, acc / SIM_FIXED_DT, frameDt);
    times.push(performance.now() - t0);

    let surface = 0;
    let flips = 0;
    for (let v = 0; v < nVox; v++) {
      const d = field.data[2 * v]!;
      const h = ((history[v]! << 1) | (d >= threshold ? 1 : 0)) & 7;
      history[v] = h;
      // « Surface » : voxels dans une bande autour du seuil.
      if (d > 0.5 * threshold && d < 1.5 * threshold) surface++;
      // Aller-retour : 010 ou 101.
      if (h === 2 || h === 5) flips++;
    }
    if (f >= settle) flipRatios.push((100 * flips) / Math.max(1, surface));
    let occ = 0;
    for (const b of field.occupancy) if (b) occ++;
    occupied += occ / field.occupancy.length;
  }

  console.log(`\n— lissage temporel ${smoothingTime} s`);
  console.log(`  splat CPU (ms)                     ${quantiles(times.slice(Math.min(100, frames >> 2)), 3)}`);
  console.log(`  allers-retours / frame (% surface) ${quantiles(flipRatios, 2)}`);
  console.log(`  blocs occupés                      ${((100 * occupied) / frames).toFixed(1)} %`);
  const vals: number[] = [];
  for (let i = 0; i < wax.count; i++) {
    vals.push(field.sampleNearest(wax.positions[3 * i]!, wax.positions[3 * i + 1]!, wax.positions[3 * i + 2]!));
  }
  console.log(`  champ aux particules               ${quantiles(vals, 2)}`);
}

{
  const f = new DensityField({ radius: maxRadius, yMin: profile.yMin, yMax: profile.yMax }, n0, { resolution, kernelRadius });
  console.log(
    `grille ${f.nx}×${f.ny}×${f.nz} (voxel ${f.cell.toFixed(4)}), noyau ${kernelRadius}, seuil ${threshold}, ` +
      `affichage ${hz} Hz ± ${100 * jitter} %, ${frames} frames après ${warmup} s`,
  );
}
run(0);
run(DEFAULT_DENSITY_FIELD_PARAMS.smoothingTime);
