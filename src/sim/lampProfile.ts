/**
 * Profil de révolution unique de la lampe (socle, verre, capuchon).
 *
 * Source de vérité géométrique partagée :
 *  - le rendu en tire les LatheGeometry (src/render/lamp.ts) ;
 *  - la physique utilise `innerRadius(y)` et `interior` pour les collisions.
 *
 * Aucune dépendance à Three.js : on manipule de simples {r, y}.
 * Unités : 1 unité = 10 cm (la lampe fait ~4.3 unités de haut), axe Y vertical,
 * sol en y = 0, axe de révolution en x = z = 0.
 */

export interface ProfilePoint {
  /** Distance à l'axe. */
  r: number;
  y: number;
}

/** Point de contrôle du verre : t ∈ [0, 1] le long de la hauteur, r rayon extérieur. */
export interface GlassControlPoint {
  t: number;
  r: number;
}

export interface LampDimensions {
  baseHeight: number;
  baseBottomRadius: number;
  baseTopRadius: number;
  glassHeight: number;
  /** Rayons extérieurs du verre, fuselé (ventre bas, col étroit). */
  glassControlPoints: readonly GlassControlPoint[];
  glassWallThickness: number;
  /** Épaisseur du fond de verre (le liquide commence au-dessus). */
  glassBottomThickness: number;
  capHeight: number;
  capTopRadius: number;
}

export const DEFAULT_LAMP_DIMENSIONS: LampDimensions = {
  baseHeight: 1.3,
  baseBottomRadius: 0.95,
  baseTopRadius: 0.54,
  glassHeight: 2.3,
  glassControlPoints: [
    { t: 0.0, r: 0.5 },
    { t: 0.2, r: 0.57 },
    { t: 0.38, r: 0.58 },
    { t: 0.7, r: 0.46 },
    { t: 1.0, r: 0.33 },
  ],
  glassWallThickness: 0.025,
  glassBottomThickness: 0.06,
  capHeight: 0.7,
  capTopRadius: 0.17,
};

/** Volume intérieur du récipient, tel que vu par la physique. */
export interface ContainerShape {
  /** Bas du liquide (dessus du fond de verre). */
  readonly yMin: number;
  /** Haut du liquide (sous le capuchon). */
  readonly yMax: number;
  /** Rayon intérieur à la hauteur y ; 0 hors de [yMin, yMax]. */
  innerRadius(y: number): number;
}

export class LampProfile implements ContainerShape {
  readonly dims: LampDimensions;
  readonly glassBottom: number;
  readonly glassTop: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly totalHeight: number;

  private readonly glassCurve: MonotoneCubic;

  constructor(dims: LampDimensions = DEFAULT_LAMP_DIMENSIONS) {
    this.dims = dims;
    this.glassBottom = dims.baseHeight;
    this.glassTop = dims.baseHeight + dims.glassHeight;
    this.yMin = this.glassBottom + dims.glassBottomThickness;
    this.yMax = this.glassTop;
    this.totalHeight = this.glassTop + dims.capHeight;
    this.glassCurve = new MonotoneCubic(
      dims.glassControlPoints.map((p) => p.t),
      dims.glassControlPoints.map((p) => p.r),
    );
  }

  /** Rayon extérieur du verre à la hauteur y (borné aux extrémités). */
  glassOuterRadius(y: number): number {
    const t = (y - this.glassBottom) / this.dims.glassHeight;
    return this.glassCurve.evaluate(Math.min(1, Math.max(0, t)));
  }

  innerRadius(y: number): number {
    if (y < this.yMin || y > this.yMax) return 0;
    return this.glassOuterRadius(y) - this.dims.glassWallThickness;
  }

  /** Socle conique, fermé sur l'axe en bas et en haut. Ordonné de bas en haut. */
  baseProfile(): ProfilePoint[] {
    const { baseHeight: h, baseBottomRadius: rb, baseTopRadius: rt } = this.dims;
    const bevel = 0.04;
    return [
      { r: 0, y: 0 },
      { r: rb - bevel, y: 0 },
      { r: rb, y: bevel },
      { r: rb, y: 0.08 },
      { r: rb - bevel, y: 0.08 + bevel },
      // Cône principal.
      { r: rt + 0.03, y: h - 0.06 },
      // Collerette qui reçoit le verre.
      { r: rt + 0.03, y: h },
      { r: this.glassOuterRadius(this.glassBottom) - 0.01, y: h },
      { r: 0, y: h },
    ];
  }

  /** Paroi extérieure du verre, échantillonnée de bas en haut (surface ouverte). */
  glassProfile(segments = 64): ProfilePoint[] {
    const points: ProfilePoint[] = [];
    for (let i = 0; i <= segments; i++) {
      const y = this.glassBottom + (i / segments) * this.dims.glassHeight;
      points.push({ r: this.glassOuterRadius(y), y });
    }
    return points;
  }

  /** Paroi intérieure du récipient (yMin → yMax), utile pour le debug des collisions. */
  innerProfile(segments = 64): ProfilePoint[] {
    const points: ProfilePoint[] = [];
    for (let i = 0; i <= segments; i++) {
      const y = this.yMin + (i / segments) * (this.yMax - this.yMin);
      points.push({ r: this.innerRadius(y), y });
    }
    return points;
  }

  /** Capuchon conique arrondi, fermé sur l'axe. Ordonné de bas en haut. */
  capProfile(): ProfilePoint[] {
    const y0 = this.glassTop;
    const { capHeight: h, capTopRadius: rt } = this.dims;
    const r0 = this.glassOuterRadius(y0);
    return [
      { r: 0, y: y0 - 0.06 },
      { r: r0 + 0.02, y: y0 - 0.06 },
      { r: r0 + 0.03, y: y0 },
      { r: rt + 0.02, y: y0 + h - 0.05 },
      { r: rt - 0.02, y: y0 + h - 0.01 },
      { r: rt - 0.06, y: y0 + h },
      { r: 0, y: y0 + h },
    ];
  }
}

/**
 * Interpolation cubique monotone (Fritsch–Carlson) : courbe C1 sans dépassement
 * entre les points de contrôle, donc pas de bosses parasites sur le verre.
 */
class MonotoneCubic {
  private readonly xs: readonly number[];
  private readonly ys: readonly number[];
  private readonly ms: number[];

  constructor(xs: readonly number[], ys: readonly number[]) {
    const n = xs.length;
    if (n < 2 || ys.length !== n) throw new Error('MonotoneCubic: au moins 2 points requis');
    this.xs = xs;
    this.ys = ys;

    const deltas: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      deltas.push((at(ys, i + 1) - at(ys, i)) / (at(xs, i + 1) - at(xs, i)));
    }
    const ms: number[] = [at(deltas, 0)];
    for (let i = 1; i < n - 1; i++) {
      const d0 = at(deltas, i - 1);
      const d1 = at(deltas, i);
      ms.push(d0 * d1 <= 0 ? 0 : (d0 + d1) / 2);
    }
    ms.push(at(deltas, n - 2));
    for (let i = 0; i < n - 1; i++) {
      const d = at(deltas, i);
      if (d === 0) {
        ms[i] = 0;
        ms[i + 1] = 0;
        continue;
      }
      const a = at(ms, i) / d;
      const b = at(ms, i + 1) / d;
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        ms[i] = tau * a * d;
        ms[i + 1] = tau * b * d;
      }
    }
    this.ms = ms;
  }

  evaluate(x: number): number {
    const { xs, ys, ms } = this;
    let i = 0;
    while (i < xs.length - 2 && x > at(xs, i + 1)) i++;
    const x0 = at(xs, i);
    const h = at(xs, i + 1) - x0;
    const t = (x - x0) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * at(ys, i) +
      (t3 - 2 * t2 + t) * h * at(ms, i) +
      (-2 * t3 + 3 * t2) * at(ys, i + 1) +
      (t3 - t2) * h * at(ms, i + 1)
    );
  }
}

function at(arr: readonly number[], i: number): number {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} hors limites`);
  return v;
}
