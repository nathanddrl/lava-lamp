/**
 * Banc d'essai headless de la cire : fait tourner la simulation N secondes
 * simulées et imprime des métriques pour régler la thermique.
 *
 *   npm run bench -- [--preset calme] [--seconds 600] [--every 30] [--set clé=valeur ...]
 *                    [--sections 10] [--snapshot] [--summary]
 *
 * - une ligne par échantillon : répartition par tranche de hauteur, réservoir,
 *   gouttes en vol, vitesse, températures ;
 * - un suivi individuel des gouttes détachées (naissance, taille, hauteur max,
 *   fusions en vol, retour au réservoir) ;
 * - un résumé avec les verdicts des objectifs ;
 * - `--sections N` : coupes ASCII (x, y) colorées par température toutes les N s.
 */
import {
  DEFAULT_PRESET,
  DEFAULT_WAX_PARAMS,
  LampProfile,
  SIM_FIXED_DT,
  Simulation,
  SpatialHashGrid,
  WAX_PRESETS,
  type PresetName,
  type WaxParams,
} from '../src/sim';

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
const presetName = (arg('preset') ?? DEFAULT_PRESET) as PresetName;
const seconds = Number(arg('seconds') ?? 600);
const every = Number(arg('every') ?? 30);
const summaryOnly = args.includes('--summary');
const sectionEvery = Number(arg('sections') ?? 0);
const overrides: Partial<Record<keyof WaxParams, number>> = {};
args.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, v] = (args[i + 1] ?? '').split('=');
  if (!k || v === undefined || !(k in DEFAULT_WAX_PARAMS)) throw new Error(`--set invalide : ${args[i + 1]}`);
  overrides[k as keyof WaxParams] = Number(v);
});
const preset = WAX_PRESETS[presetName];
if (!preset) throw new Error(`preset inconnu : ${presetName}`);

// ---------------------------------------------------------------- simulation
const profile = new LampProfile();
const sim = new Simulation(profile, { ...preset, ...overrides });
const wax = sim.wax;
const n = wax.count;
const { yMin, yMax } = profile;
const H = yMax - yMin;
const WARMUP = 60; // s ignorées dans le résumé (mise en route)
const SLICES = 10;
const BOTTOM = yMin + 0.2 * H; // zone « réservoir » pour la répartition
const TOUCH = yMin + 0.12; // un amas qui descend sous cette hauteur fait partie du réservoir
const MIN_DROP = 5; // en dessous : fragment, pas une goutte

// ---------------------------------------------------------------- amas (union-find + grille)
const parent = new Int32Array(n);
const grid = new SpatialHashGrid(n);
const nbr = new Int32Array(256);
function find(a: number): number {
  while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
  return a;
}
/** Étiquette chaque particule par la racine de son amas (liens < 0.9 h). */
function labelClusters(): void {
  const x = wax.positions;
  const link = 0.9 * wax.params.interactionRadius;
  for (let i = 0; i < n; i++) parent[i] = i;
  grid.build(x, n, link);
  for (let i = 0; i < n; i++) {
    const k = grid.query(x, x[3 * i]!, x[3 * i + 1]!, x[3 * i + 2]!, link, nbr, 0, nbr.length, i);
    for (let m = 0; m < k; m++) {
      const a = find(i);
      const b = find(nbr[m]!);
      if (a !== b) parent[a] = b;
    }
  }
}

// ---------------------------------------------------------------- suivi des gouttes
interface Drop {
  id: number;
  born: number;
  birthSize: number;
  maxSize: number;
  /** Hauteur max (normalisée) de la tête : moyenne des 3 particules les plus hautes. */
  maxHead: number;
  /** Instant où la tête dépasse 85 % de la hauteur. */
  reachedTop?: number;
  end?: number;
  fate?: 'réservoir' | 'fusion' | 'fin';
}
const drops: Drop[] = [];
const live = new Map<number, Drop>();
let nextDropId = 0;
let inFlightMerges = 0;
/** Goutte à laquelle appartenait chaque particule au dernier suivi (−1 : aucune). */
let prevDrop = new Int32Array(n).fill(-1);
let curDrop = new Int32Array(n).fill(-1);

function trackDrops(t: number): { reservoirFrac: number; inFlight: number; reservoirTop: number } {
  labelClusters();
  const x = wax.positions;
  const members = new Map<number, number[]>();
  const touches = new Set<number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let list = members.get(r);
    if (!list) members.set(r, (list = []));
    list.push(i);
    if (x[3 * i + 1]! < TOUCH) touches.add(r);
  }
  curDrop.fill(-1);
  let reservoirCount = 0;
  let reservoirTop = 0;
  const seen = new Set<number>();
  let inFlight = 0;
  for (const [root, list] of members) {
    if (touches.has(root)) {
      reservoirCount += list.length;
      for (const i of list) reservoirTop = Math.max(reservoirTop, (x[3 * i + 1]! - yMin) / H);
      continue;
    }
    if (list.length < MIN_DROP) continue;
    inFlight++;
    // Gouttes précédentes représentées dans cet amas.
    const votes = new Map<number, number>();
    for (const i of list) {
      const d = prevDrop[i]!;
      if (d >= 0) votes.set(d, (votes.get(d) ?? 0) + 1);
    }
    const contributors = [...votes.entries()].filter(([, c]) => c >= MIN_DROP).sort((a, b) => b[1] - a[1]);
    let drop: Drop;
    const heir = contributors.find(([id]) => live.has(id) && !seen.has(id));
    if (heir) {
      drop = live.get(heir[0])!;
      // Les autres gouttes qui ont rejoint celle-ci : fusion en vol.
      for (const [id] of contributors) {
        if (id === drop.id || !live.has(id)) continue;
        const other = live.get(id)!;
        other.end = t;
        other.fate = 'fusion';
        live.delete(id);
        inFlightMerges++;
      }
    } else {
      drop = { id: nextDropId++, born: t, birthSize: list.length, maxSize: list.length, maxHead: 0 };
      drops.push(drop);
      live.set(drop.id, drop);
    }
    seen.add(drop.id);
    drop.maxSize = Math.max(drop.maxSize, list.length);
    const ys = list.map((i) => x[3 * i + 1]!).sort((a, b) => b - a);
    const head = (ys[0]! + ys[1]! + ys[2]!) / 3;
    drop.maxHead = Math.max(drop.maxHead, (head - yMin) / H);
    if (drop.reachedTop === undefined && drop.maxHead >= 0.85) drop.reachedTop = t;
    for (const i of list) curDrop[i] = drop.id;
  }
  // Gouttes non retrouvées : revenues au réservoir.
  for (const [id, d] of live) {
    if (seen.has(id)) continue;
    d.end = t;
    d.fate = 'réservoir';
    live.delete(id);
  }
  [prevDrop, curDrop] = [curDrop, prevDrop];
  return { reservoirFrac: reservoirCount / n, inFlight, reservoirTop };
}

// ---------------------------------------------------------------- coupes ASCII
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

// ---------------------------------------------------------------- boucle
const stepsPerSample = Math.round(every / SIM_FIXED_DT);
const stepsPerTrack = Math.round(1 / SIM_FIXED_DT);
const totalSteps = Math.round(seconds / SIM_FIXED_DT);
const BARS = ' ▁▂▃▄▅▆▇█';
const bottomSeries: number[] = [];
const upperSeries: number[] = [];
let simMs = 0;
let lastTrack = { reservoirFrac: 1, inFlight: 0, reservoirTop: 0 };
/** Secondes où le réservoir est relié, sans rupture, à la cire au-dessus de 80 % (fontaine). */
let columnSeconds = 0;
let trackedSeconds = 0;
let column = 0;
let longestColumn = 0;

if (!summaryOnly) {
  console.log(`preset=${presetName} N=${n} durée=${seconds}s dt=${SIM_FIXED_DT.toFixed(4)} overrides=${JSON.stringify(overrides)}`);
  console.log('     t | tranches bas→haut | bas20% rés.% | en vol | v moy  | T moy  T max');
}
for (let s = 1; s <= totalSteps; s++) {
  const t0 = performance.now();
  sim.step(SIM_FIXED_DT);
  simMs += performance.now() - t0;
  const t = s * SIM_FIXED_DT;

  if (s % stepsPerTrack === 0) {
    lastTrack = trackDrops(t);
    if (t >= WARMUP) {
      trackedSeconds++;
      if (lastTrack.reservoirTop > 0.8) {
        columnSeconds++;
        column++;
      } else column = 0;
      longestColumn = Math.max(longestColumn, column);
      let bottom = 0;
      let upper = 0;
      for (let i = 0; i < n; i++) {
        const y = wax.positions[3 * i + 1]!;
        if (y < BOTTOM) bottom++;
        if (y > yMin + 0.5 * H) upper++;
      }
      bottomSeries.push(bottom / n);
      upperSeries.push(upper / n);
    }
  }
  if (sectionEvery > 0 && s % Math.round(sectionEvery / SIM_FIXED_DT) === 0) printSection(`t=${t.toFixed(0)}s`);
  if (summaryOnly || s % stepsPerSample !== 0) continue;

  const x = wax.positions;
  const v = wax.velocities;
  const T = wax.temperatures;
  const hist = new Array<number>(SLICES).fill(0);
  let speed = 0;
  let meanT = 0;
  let maxT = 0;
  let bottom = 0;
  for (let i = 0; i < n; i++) {
    const y = x[3 * i + 1]!;
    hist[Math.min(SLICES - 1, Math.max(0, Math.floor(((y - yMin) / H) * SLICES)))]!++;
    speed += Math.hypot(v[3 * i]!, v[3 * i + 1]!, v[3 * i + 2]!);
    meanT += T[i]!;
    maxT = Math.max(maxT, T[i]!);
    if (y < BOTTOM) bottom++;
  }
  const bars = hist.map((h) => BARS[Math.min(8, Math.ceil((h / n) * 16))]).join('');
  console.log(
    `${t.toFixed(0).padStart(6)} | ${bars.padEnd(17)} | ${((bottom / n) * 100).toFixed(0).padStart(5)} ${(lastTrack.reservoirFrac * 100).toFixed(0).padStart(5)} | ${String(lastTrack.inFlight).padStart(6)} | ${(speed / n).toFixed(3)}  | ${(meanT / n).toFixed(2)}   ${maxT.toFixed(2)}`,
  );
}
for (const d of live.values()) d.fate = 'fin';

// ---------------------------------------------------------------- résumé
function median(a: number[]): number {
  if (a.length === 0) return NaN;
  const s = [...a].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)]!;
}
function cv(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = a.reduce((p, q) => p + q, 0) / a.length;
  const sd = Math.sqrt(a.reduce((p, q) => p + (q - m) ** 2, 0) / a.length);
  return sd / m;
}
const pct = (k: number, total: number): string => (total ? `${((k / total) * 100).toFixed(0)} %` : '—');

const counted = drops.filter((d) => d.born >= WARMUP);
const sizes = counted.map((d) => d.maxSize);
const inTarget = sizes.filter((k) => k >= 40 && k <= 150).length;
const binsOf = (a: number[]) =>
  [
    ['5–19', a.filter((k) => k < 20).length],
    ['20–39', a.filter((k) => k >= 20 && k < 40).length],
    ['40–150', a.filter((k) => k >= 40 && k <= 150).length],
    ['151–250', a.filter((k) => k > 150 && k <= 250).length],
    ['>250', a.filter((k) => k > 250).length],
  ] as const;
const birthSizes = counted.map((d) => d.birthSize);
const bins = [
  ['5–39', sizes.filter((k) => k < 40).length],
  ['40–150', inTarget],
  ['151–250', sizes.filter((k) => k > 150 && k <= 250).length],
  ['>250', sizes.filter((k) => k > 250).length],
] as const;
// Têtes : gouttes d'au moins 20 particules (les fragments ne comptent pas).
const heads = counted.filter((d) => d.maxSize >= 20 && d.fate !== 'fin');
const high = heads.filter((d) => d.maxHead >= 0.9).length;
const riseTimes = heads.filter((d) => d.reachedTop !== undefined).map((d) => d.reachedTop! - d.born);
const births = counted.map((d) => d.born).sort((a, b) => a - b);
const gaps = births.slice(1).map((b, i) => b - births[i]!);

// Cycle arrêté : plus longue fenêtre sans aucune cire au-dessus de mi-hauteur.
let idle = 0;
let longestIdle = 0;
for (const u of upperSeries) {
  idle = u < 0.01 ? idle + 1 : 0;
  longestIdle = Math.max(longestIdle, idle);
}
const stuckTop = bottomSeries.filter((b) => b < 0.1).length;
const resMin = Math.min(...bottomSeries);
const resMean = bottomSeries.reduce((p, q) => p + q, 0) / bottomSeries.length;

const lines = [
  `--- résumé ${presetName} ${JSON.stringify(overrides)} (${seconds} s, après ${WARMUP} s de mise en route)`,
  `coût sim : ${(simMs / totalSteps).toFixed(2)} ms/pas fixe`,
  `réservoir (bas 20 %) : min ${(resMin * 100).toFixed(0)} %, moyenne ${(resMean * 100).toFixed(0)} %`,
  `gouttes détachées : ${counted.length} (${(counted.length / ((seconds - WARMUP) / 60)).toFixed(1)}/min) ; taille max/goutte médiane ${median(sizes)}, max ${Math.max(0, ...sizes)} ; CV ${cv(sizes).toFixed(2)}`,
  `  distribution : ${bins.map(([k, c]) => `${k}: ${c}`).join(' | ')} → 40–150 : ${pct(inTarget, sizes.length)}`,
  `  taille max  : ${binsOf(sizes).map(([k, c]) => `${k}: ${c}`).join(' | ')}`,
  `  à la naissance : ${binsOf(birthSizes).map(([k, c]) => `${k}: ${c}`).join(' | ')} (médiane ${median(birthSizes)})`,
  `têtes (≥ 20 part.) : ${heads.length}, hauteur max médiane ${(median(heads.map((d) => d.maxHead)) * 100).toFixed(0)} %, ≥ 90 % : ${pct(high, heads.length)}`,
  `montée (détachement → 85 %) médiane ${median(riseTimes).toFixed(1)} s`,
  `variété : fusions en vol ${inFlightMerges}, intervalle entre départs médian ${median(gaps).toFixed(1)} s (CV ${cv(gaps).toFixed(2)})`,
  `colonne permanente (réservoir relié à > 80 %) : ${pct(columnSeconds, trackedSeconds)} du temps, plus longue ${longestColumn} s`,
  `verdicts : plus longue pause sans cire en haut ${longestIdle} s, échantillons « tout en haut » ${stuckTop}`,
];
console.log(lines.join('\n'));
const ok = (b: boolean): string => (b ? 'OK ' : '-- ');
console.log(
  `OBJECTIFS ${ok(sizes.length > 0 && inTarget / sizes.length >= 0.5)}40–150 majoritaire  ${ok(sizes.every((k) => k <= 250))}aucune > 250  ${ok(resMin >= 0.4)}réservoir ≥ 40 %  ${ok(heads.length > 0 && high / heads.length > 0.5)}têtes ≥ 90 %  ${ok(longestIdle < 60 && stuckTop === 0)}cycle continu  ${ok(columnSeconds <= 0.25 * trackedSeconds && longestColumn < 30)}pas de colonne permanente`,
);
if (args.includes('--snapshot')) printSection('finale');
