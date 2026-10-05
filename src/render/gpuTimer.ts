/**
 * Temps GPU d'une portion de frame via EXT_disjoint_timer_query_webgl2.
 * Les résultats arrivent avec quelques frames de retard (requêtes asynchrones) ;
 * `ms` reste NaN si l'extension est absente (Firefox, Safari, rendu logiciel).
 */
export class GpuTimer {
  /** Moyenne glissante du temps GPU (ms), NaN si indisponible. */
  ms = Number.NaN;
  readonly available: boolean;

  private readonly gl: WebGL2RenderingContext;
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as GpuTimer['ext'];
    this.available = this.ext !== null;
  }

  begin(): void {
    if (!this.ext || this.active || this.pending.length > 4) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  private poll(): void {
    const { gl, ext } = this;
    if (!ext) return;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length > 0) {
      const q = this.pending[0]!;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(q);
      if (disjoint) continue;
      const ms = ns / 1e6;
      this.ms = Number.isNaN(this.ms) ? ms : this.ms + (ms - this.ms) * 0.05;
    }
  }

  dispose(): void {
    for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q);
    if (this.active) this.gl.deleteQuery(this.active);
    this.pending.length = 0;
    this.free.length = 0;
  }
}
