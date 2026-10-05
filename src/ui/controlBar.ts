import './controlBar.css';

export interface ControlBarTheme {
  id: string;
  label: string;
  wax: string;
  liquid: string;
}

export interface ControlBarMode {
  id: string;
  label: string;
  /** Libellé court pour les écrans étroits. */
  short: string;
}

export interface ControlBarOptions {
  themes: readonly ControlBarTheme[];
  modes: readonly ControlBarMode[];
  theme: string;
  mode: string;
  onTheme: (id: string) => void;
  onMode: (id: string) => void;
  onPause: (paused: boolean) => void;
  onFullscreen: () => void;
  /** Masquée après ce délai sans interaction (ms). */
  hideDelay?: number;
}

const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
const ICON_FULL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
const ICON_EXIT =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>';

/**
 * Interface finale minimale : thème, ambiance, pause, plein écran. Purement
 * présentation : les décisions sont prises par les callbacks (main.ts).
 * Se retire après quelques secondes sans interaction, revient au moindre mouvement.
 */
export class ControlBar {
  readonly element: HTMLElement;

  private readonly options: ControlBarOptions;
  private readonly themeButtons = new Map<string, HTMLButtonElement>();
  private readonly modeButtons = new Map<string, HTMLButtonElement>();
  private readonly pauseButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement | null;
  private paused = false;
  private hideTimer = 0;
  private readonly onActivity = (): void => this.reveal();
  private readonly onFullscreenChange = (): void => this.syncFullscreen();

  constructor(parent: HTMLElement, options: ControlBarOptions) {
    this.options = options;
    const bar = document.createElement('nav');
    bar.className = 'lava-bar';
    bar.setAttribute('aria-label', 'Réglages de la lampe');

    const themes = group('Thème');
    for (const t of options.themes) {
      const b = button(`<span></span>`, `Thème ${t.label}`);
      b.classList.add('lava-bar__swatch');
      b.style.setProperty('--wax', t.wax);
      b.style.setProperty('--liquid', t.liquid);
      b.addEventListener('click', () => {
        this.setTheme(t.id);
        options.onTheme(t.id);
      });
      this.themeButtons.set(t.id, b);
      themes.append(b);
    }

    const modes = group('Ambiance');
    for (const m of options.modes) {
      const b = button(
        `<span class="lava-bar__long">${m.label}</span><span class="lava-bar__short">${m.short}</span>`,
        `Ambiance ${m.label.toLowerCase()}`,
      );
      b.classList.add('lava-bar__mode');
      b.addEventListener('click', () => {
        this.setMode(m.id);
        options.onMode(m.id);
      });
      this.modeButtons.set(m.id, b);
      modes.append(b);
    }

    this.pauseButton = button(ICON_PAUSE, 'Pause (espace)');
    this.pauseButton.addEventListener('click', () => {
      this.setPaused(!this.paused);
      options.onPause(this.paused);
    });

    // iPhone : pas d'API plein écran pour une page, on n'affiche pas un bouton inerte.
    const fullscreenSupported = document.fullscreenEnabled === true;
    this.fullscreenButton = fullscreenSupported ? button(ICON_FULL, 'Plein écran (F)') : null;
    this.fullscreenButton?.addEventListener('click', () => options.onFullscreen());

    const actions = group('Actions');
    actions.append(this.pauseButton);
    if (this.fullscreenButton) actions.append(this.fullscreenButton);

    bar.append(themes, separator(), modes, separator(), actions);
    parent.append(bar);
    this.element = bar;

    this.setTheme(options.theme);
    this.setMode(options.mode);
    window.addEventListener('pointermove', this.onActivity, { passive: true });
    window.addEventListener('pointerdown', this.onActivity, { passive: true });
    window.addEventListener('keydown', this.onActivity);
    bar.addEventListener('focusin', this.onActivity);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
    this.reveal();
  }

  setTheme(id: string): void {
    for (const [k, b] of this.themeButtons) b.setAttribute('aria-pressed', String(k === id));
  }

  setMode(id: string): void {
    for (const [k, b] of this.modeButtons) b.setAttribute('aria-pressed', String(k === id));
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.pauseButton.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    const label = paused ? 'Reprendre (espace)' : 'Pause (espace)';
    this.pauseButton.setAttribute('aria-label', label);
    this.pauseButton.title = label;
  }

  /** Affiche la barre et relance le délai de retrait. */
  reveal(): void {
    this.element.classList.remove('is-hidden');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      // Ne pas retirer la barre sous le pointeur ou pendant une navigation au clavier.
      if (this.element.matches(':hover, :focus-within')) this.reveal();
      else this.element.classList.add('is-hidden');
    }, this.options.hideDelay ?? 3500);
  }

  private syncFullscreen(): void {
    if (!this.fullscreenButton) return;
    const on = document.fullscreenElement !== null;
    this.fullscreenButton.innerHTML = on ? ICON_EXIT : ICON_FULL;
    const label = on ? 'Quitter le plein écran (F)' : 'Plein écran (F)';
    this.fullscreenButton.setAttribute('aria-label', label);
    this.fullscreenButton.title = label;
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    window.removeEventListener('pointermove', this.onActivity);
    window.removeEventListener('pointerdown', this.onActivity);
    window.removeEventListener('keydown', this.onActivity);
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    this.element.remove();
  }
}

function group(label: string): HTMLElement {
  const g = document.createElement('div');
  g.className = 'lava-bar__group';
  g.setAttribute('role', 'group');
  g.setAttribute('aria-label', label);
  return g;
}

function separator(): HTMLElement {
  const s = document.createElement('span');
  s.className = 'lava-bar__sep';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

function button(html: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = html;
  b.setAttribute('aria-label', label);
  b.title = label;
  return b;
}

/** Remplace la page par un message lisible (WebGL2 absent, contexte GPU perdu). */
export function showFatal(title: string, message: string, action?: { label: string; run: () => void }): void {
  const root = document.createElement('div');
  root.className = 'lava-fatal';
  root.setAttribute('role', 'alert');
  const box = document.createElement('div');
  box.className = 'lava-fatal__box';
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  box.append(h, p);
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', action.run);
    box.append(b);
  }
  root.append(box);
  document.body.append(root);
}
