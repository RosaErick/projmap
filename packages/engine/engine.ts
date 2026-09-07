import { Renderer, IDENTITY_VIEW, type ViewTransform } from './render/renderer.ts';
import { SourcePool } from './sources/index.ts';
import type { CanvasModule } from './sources/types.ts';
import { Store, visibleSurfaces, patternFor, presentationOf, isFading, type StoreState } from './model/store.ts';
import { emptyProject, type Project, type Source, type TestPattern, type Vec2 } from './model/project.ts';

export interface EngineOptions {
  /** Share a store between the editor window and the output window. */
  store?: Store;
  /**
   * Share the source pool too. A GL texture cannot cross a window, but the
   * `<video>`, the decoder and the capture stream behind it can — and must, or
   * opening the output decodes every clip twice and asks for screen-capture
   * permission a second time.
   */
  pool?: SourcePool;
  /** Turns project-relative media paths into loadable URLs. Defaults to using
   *  the path as-is, which is what a plain `file://` or dev server wants. */
  resolveUrl?: (path: string) => Promise<string>;
  loadModule?: (moduleId: string) => Promise<CanvasModule>;
  /** Render at the projector's native pixels regardless of CSS size. */
  devicePixelRatio?: number;
}

/**
 * The whole engine behind one object: a store in, frames out.
 *
 * It owns a canvas, a renderer, a source pool and a render loop, and nothing
 * else. No UI framework, no DOM outside its canvas, no globals. Any host that
 * can hand it a canvas and a Project gets the same picture the editor shows.
 */
export class Engine {
  readonly store: Store;
  readonly renderer: Renderer;
  readonly pool: SourcePool;

  #canvas: HTMLCanvasElement;
  /** The canvas' own window: the output window runs its loop on its own clock. */
  #win: Window;
  #raf = 0;
  #dirty = true;
  #wasFading = false;
  #running = false;
  #view: ViewTransform = IDENTITY_VIEW;
  #unsubscribe: () => void;
  #dpr: number;
  #ownsPool: boolean;
  /** Source list the pool was last reconciled against, by identity. */
  #syncedSources: readonly Source[] | null = null;
  #unlockBound: () => void;

  constructor(canvas: HTMLCanvasElement, project: Project = emptyProject(), opts: EngineOptions = {}) {
    this.#canvas = canvas;
    this.#win = canvas.ownerDocument.defaultView ?? window;
    this.store = opts.store ?? new Store(project);
    this.renderer = new Renderer(canvas);
    this.#ownsPool = !opts.pool;
    this.pool = opts.pool ?? new SourcePool({
      resolveUrl: opts.resolveUrl ?? (async (p) => p),
      loadModule: opts.loadModule,
    });
    this.#dpr = opts.devicePixelRatio ?? 1;
    // Any state change invalidates the frame. Everything else stays asleep.
    this.#unsubscribe = this.store.subscribe(() => { this.#dirty = true; });

    // Browsers block autoplay until a gesture; one listener unlocks every clip.
    this.#unlockBound = () => this.pool.unlock();
    canvas.ownerDocument.addEventListener('pointerdown', this.#unlockBound, { once: false });
  }

  /** Editor pan/zoom. The output window never calls this. */
  setView(view: ViewTransform): void {
    this.#view = view;
    this.#dirty = true;
  }

  get view(): ViewTransform { return this.#view; }

  /** Sizes the drawing buffer. Pass the projector's native resolution. */
  resize(width: number, height: number): void {
    this.renderer.resize(width, height, this.#dpr);
    this.#dirty = true;
  }

  invalidate(): void { this.#dirty = true; }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (): void => {
      if (!this.#running) return;
      this.#frame();
      this.#raf = this.#win.requestAnimationFrame(loop);
    };
    this.#raf = this.#win.requestAnimationFrame(loop);
  }

  stop(): void {
    this.#running = false;
    this.#win.cancelAnimationFrame(this.#raf);
  }

  #frame(): void {
    const gl = this.renderer.gl;
    const state = this.store.state;

    // Reconciling the pool means walking every source and building a set. It
    // only has anything to do when the source list itself changed — and when it
    // does, the store's notification has already marked the frame dirty.
    if (state.project.sources !== this.#syncedSources) {
      this.pool.sync(gl, state.project.sources, state.view.sourceRevisions);
      this.#syncedSources = state.project.sources;
    }

    // Uploading is cheap when nothing is stale — one map lookup per source —
    // and it has to happen before the decision, because "a texture just
    // arrived" is one of the three reasons to draw a frame at all.
    const uploaded = this.pool.update(gl);

    // An idle installation must not hold the GPU at 60fps for nothing.
    // Uma transição muda a opacidade continuamente sem escrever no store, então
    // ela precisa acordar o laço explicitamente. "Tocando" não bastaria nem
    // seria certo: cena parada com conteúdo parado não tem por que segurar a GPU.
    const fading = isFading(state);
    // The first frame after a fade ends must draw its exact final state,
    // even when the browser skipped the last part of the transition.
    if (!this.#dirty && !uploaded && !this.pool.hasAnimated && !fading && !this.#wasFading) return;
    this.#wasFading = fading;
    this.#dirty = false;
    this.renderFrame(state);
  }

  /** Draw one frame now, regardless of the dirty flag.
   *  Callers give the view in CSS pixels; the device pixel ratio is folded in
   *  here so no caller has to remember it. */
  renderFrame(state: StoreState = this.store.state): void {
    const v = this.#dpr === 1 ? this.#view : {
      scale: this.#view.scale * this.#dpr,
      tx: this.#view.tx * this.#dpr,
      ty: this.#view.ty * this.#dpr,
    };
    this.renderer.render(
      state.project,
      visibleSurfaces(state),
      this.pool,
      v,
      (surface) => patternFor(state, surface.id),
      (surface) => presentationOf(state, surface),
    );
  }

  // --- the public API from the brief ---------------------------------------

  load(projectJson: string | unknown): void { this.store.load(projectJson); }
  setSurfaceFrame(id: string, corners: [Vec2, Vec2, Vec2, Vec2]): void { this.store.setSurfaceFrame(id, corners); }
  setSurfaceSource(id: string, sourceId: string | null): void { this.store.setSurfaceSource(id, sourceId); }
  setTestPattern(pattern: TestPattern): void { this.store.setTestPattern(pattern); }
  setSurfacePattern(id: string, pattern: TestPattern | null): void { this.store.setSurfacePattern(id, pattern); }

  /** Only 'change' exists today; the signature leaves room for more. */
  on(event: 'change', cb: (state: StoreState) => void): () => void {
    if (event !== 'change') throw new Error(`evento desconhecido: ${String(event)}`);
    return this.store.subscribe(cb);
  }

  dispose(): void {
    this.stop();
    this.#unsubscribe();
    this.#canvas.ownerDocument.removeEventListener('pointerdown', this.#unlockBound);
    // A borrowed pool outlives this engine: drop only this context's textures.
    if (this.#ownsPool) this.pool.disposeAll(this.renderer.gl);
    else this.pool.releaseContext(this.renderer.gl);
    this.renderer.dispose();
  }
}

export function createEngine(canvas: HTMLCanvasElement, project?: Project, opts?: EngineOptions): Engine {
  return new Engine(canvas, project, opts);
}
