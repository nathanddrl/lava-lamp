/**
 * Banc d'essai headless de la cire : fait tourner la simulation N secondes
 * simulées et imprime des métriques pour régler la thermique.
 *
 *   npm run bench -- [--preset calme] [--seconds 300] [--every 10] [--set clé=valeur ...]
 *
 * Sortie : une ligne par échantillon (répartition par tranche de hauteur, amas,
 * vitesse, température), puis un résumé (cycles, durées de montée/descente, verdicts).
 */
import { DEFAULT_PRESET, DEFAULT_WAX_PARAMS, LampProfile, SIM_FIXED_DT, Simulation, WAX_PRESETS, type PresetName, type WaxParams } from '../src/sim';

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const presetName = (arg('preset') ?? DEFAULT_PRESET) as PresetName;
const seconds = Number(arg('seconds') ?? 300);
const every = Number(arg('every') ?? 10);
const quiet = args.includes('--quiet');
const overrides: Partial<Record<keyof WaxParams, number>> = {};
args.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = (args[i + 1] ?? '').split('=');
  if (!k || v === undefined || !(k in DEFAULT_WAX_PARAMS)) throw new Error(`--set invalide : ${args[i + 1]}`);
  overrides[k as keyof WaxParams] = Number(v);
});
const preset = WAX_PRESETS[presetName];
if (!preset) throw new Error(`preset inconnu : ${presetName}`);

const profile = new LampProfile();
const sim = new Simulation(profile, { ...preset, ...overrides });
const wax = sim.wax;
const n = wax.count;
const { yMin, yMax } = profile;
const H = yMax - yMin;
const SLICES = 10;
const BOTTOM = yMin + 0.2 * H; // zone réservoir
const TOP = yMin + 0.75 * H; // zone haute

// --- Amas (union-find sur la grille implicite : O(N²) mais seulement à l'échantillonnage)
const parent = new Int32Array(n);
function find(a: number): number {
  while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
  return a;
}
function clusters(): { sizes: number[]; reservoir: number } {
  const x = wax.positions;
  const link2 = (0.9 * wax.params.interactionRadius) ** 2;
  for (let i = 0; i < n; i++) parent[i] = i;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = x[3 * i]! - x[3 * j]!;
      const dy = x[3 * i + 1]! - x[3 * j + 1]!;
      const dz = x[3 * i + 2]! - x[3 * j + 2]!;
      if (dx * dx + dy * dy + dz * dz < link2) parent[find(i)] = find(j);
    }
  }
  const size = new Map<number, number>();
  const touchesBottom = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    size.set(r, (size.get(r) ?? 0) + 1);
    if (x[3 * i + 1]! < yMin + 0.1) touchesBottom.add(r);
  }
  let reservoir = 0;
  for (const r of touchesBottom) reservoir = Math.max(reservoir, size.get(r)!);
  return { sizes: [...size.values()].sort((a, b) => b - a), reservoir };
}

// --- Trajets : une particule part du réservoir et atteint le haut (montée), et retour (descente).
const zone = new Int8Array(n); // -1 bas, +1 haut, 0 entre
const leftAt = new Float64Array(n).fill(NaN);
const rises: number[] = [];
const falls: number[] = [];
function trackTrips(t: number): void {
  const x = wax.positions;
  for (let i = 0; i < n; i++) {
    const y = x[3 * i + 1]!;
    const z = y < BOTTOM ? -1 : y > TOP ? 1 : 0;
    const prev = zone[i]!;
    if (z === 0 && prev !== 0) leftAt[i] = t;
    if (z !== 0 && prev === 0 && !Number.isNaN(leftAt[i]!)) {
      // On ne compte que les traversées complètes bas→haut ou haut→bas.
      if (z === 1 && lastExtreme[i] === -1) rises.push(t - leftAt[i]!);
      if (z === -1 && lastExtreme[i] === 1) falls.push(t - leftAt[i]!);
    }
    if (z !== 0) lastExtreme[i] = z;
    zone[i] = z;
  }
}
const lastExtreme = new Int8Array(n);

function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)]!;
}

// --- Coupe : x horizontal, y vertical ; caractère = température moyenne de la cellule.
function printSection(label: string): void {
  const cols = 28;
  const rows = 30;
  const R = 0.6;
  const sumT = new Float64Array(cols * rows);
  const cnt = new Int32Array(cols * rows);
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(((wax.positions[3 * i]! + R) / (2 * R)) * cols);
    const cy = Math.floor(((wax.positions[3 * i + 1]! - yMin) / H) * rows);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    sumT[cy * cols + cx]! += wax.temperatures[i]!;
    cnt[cy * cols + cx]!++;
  }
  const ramp = '.:-=+*#%@';
  const lines: string[] = [];
  for (let r = rows - 1; r >= 0; r--) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const k = cnt[r * cols + c]!;
      line += k === 0 ? ' ' : ramp[Math.min(8, Math.floor((sumT[r * cols + c]! / k) * 9))];
    }
    lines.push(`|${line}|`);
  }
  console.log(`coupe ${label} (. froid → @ chaud)\n${lines.join('\n')}`);
}
const sectionEvery = Number(arg('sections') ?? 0);

// --- Boucle
const stepsPerSample = Math.round(every / SIM_FIXED_DT);
const totalSteps = Math.round(seconds / SIM_FIXED_DT);
const samples: { t: number; bottom: number; top: number; mid: number; blobs: number; detached: number[]; speed: number; meanT: number }[] = [];
const BARS = ' ▁▂▃▄▅▆▇█';
let simMs = 0;

if (!quiet) {
  console.log(`preset=${presetName} N=${n} durée=${seconds}s dt=${SIM_FIXED_DT.toFixed(4)} overrides=${JSON.stringify(overrides)}`);
  console.log('   t  | tranches bas→haut | bas%  mil%  haut% | amas≥5 détachés (tailles)        | v moy  | T moy  T rés. T max');
}
for (let s = 1; s <= totalSteps; s++) {
  const t0 = performance.now();
  sim.step(SIM_FIXED_DT);
  simMs += performance.now() - t0;
  const t = s * SIM_FIXED_DT;
  if (s % 6 === 0) trackTrips(t);
  if (sectionEvery > 0 && s % Math.round(sectionEvery / SIM_FIXED_DT) === 0) printSection(`t=${t.toFixed(0)}s`);
  if (s % stepsPerSample !== 0) continue;

  const x = wax.positions;
  const v = wax.velocities;
  const T = wax.temperatures;
  const hist = new Array<number>(SLICES).fill(0);
  let speed = 0;
  let meanT = 0;
  let resT = 0;
  let resN = 0;
  let maxT = 0;
  for (let i = 0; i < n; i++) {
    const y = x[3 * i + 1]!;
    hist[Math.min(SLICES - 1, Math.max(0, Math.floor(((y - yMin) / H) * SLICES)))]!++;
    speed += Math.hypot(v[3 * i]!, v[3 * i + 1]!, v[3 * i + 2]!);
    meanT += T[i]!;
    maxT = Math.max(maxT, T[i]!);
    if (y < BOTTOM) {
      resT += T[i]!;
      resN++;
    }
  }
  const c = clusters();
  const big = c.sizes.filter((k) => k >= 5);
  const detached = big.filter((k) => k !== c.reservoir);
  const bottom = hist.slice(0, 2).reduce((a, b) => a + b, 0) / n;
  const top = hist.slice(7).reduce((a, b) => a + b, 0) / n;
  const mid = 1 - bottom - top;
  samples.push({ t, bottom, top, mid, blobs: big.length, detached, speed: speed / n, meanT: meanT / n });
  if (!quiet) {
    const bars = hist.map((h) => BARS[Math.min(8, Math.ceil((h / n) * 16))]).join('');
    const det = detached.slice(0, 6).join(',') + (detached.length > 6 ? ',…' : '');
    console.log(
      `${t.toFixed(0).padStart(5)} | ${bars.padEnd(17)} | ${(bottom * 100).toFixed(0).padStart(4)}  ${(mid * 100).toFixed(0).padStart(4)}  ${(top * 100).toFixed(0).padStart(4)} | ${String(big.length).padStart(3)} ${String(detached.length).padStart(3)} (${det})`.padEnd(78) +
        `| ${(speed / n).toFixed(3)}  | ${(meanT / n).toFixed(2)}   ${(resN ? resT / resN : NaN).toFixed(2)}   ${maxT.toFixed(2)}`,
    );
  }
}

// --- Résumé et verdicts (ignore la première minute : mise en route)
const warm = samples.filter((s) => s.t >= 60);
const stuckTop = warm.filter((s) => s.bottom < 0.1).length;
const stagnant = warm.filter((s) => s.mid + s.top < 0.02).length;
// Fenêtres de 60 s sans aucune cire au-dessus de 40 % → cycle arrêté.
let longestIdle = 0;
let idle = 0;
for (const s of warm) {
  idle = s.mid + s.top < 0.02 ? idle + every : 0;
  longestIdle = Math.max(longestIdle, idle);
}
const detachedSizes = warm.flatMap((s) => s.detached);
const reservoirMin = Math.min(...warm.map((s) => s.bottom));
const riseMed = median(rises);
const fallMed = median(falls);
console.log('\n--- résumé (après 60 s de mise en route)');
console.log(`coût sim : ${(simMs / totalSteps).toFixed(2)} ms/pas fixe`);
console.log(`réservoir (bas 20 %) : min ${(reservoirMin * 100).toFixed(0)} %, moyenne ${((warm.reduce((a, s) => a + s.bottom, 0) / warm.length) * 100).toFixed(0)} %`);
console.log(`cire au-dessus du réservoir : moyenne ${((warm.reduce((a, s) => a + s.mid + s.top, 0) / warm.length) * 100).toFixed(0)} %`);
console.log(`amas détachés (≥5) : ${(detachedSizes.length / Math.max(1, warm.length)).toFixed(2)} par échantillon, tailles médiane ${median(detachedSizes)}, max ${Math.max(0, ...detachedSizes)}`);
console.log(`montées complètes : ${rises.length} trajets particule, médiane ${riseMed.toFixed(1)} s ; descentes : ${falls.length}, médiane ${fallMed.toFixed(1)} s`);
console.log(`vitesse moyenne : ${(warm.reduce((a, s) => a + s.speed, 0) / warm.length).toFixed(3)} u/s`);
console.log(`verdicts : collé-en-haut=${stuckTop} échantillons, stagnation=${stagnant} échantillons, plus longue pause=${longestIdle} s`);

if (args.includes('--snapshot')) printSection('finale');
