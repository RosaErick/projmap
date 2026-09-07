import {
  DEFAULT_CELLS, identityWarp, resampleWarp, type WarpInterpolation,
} from './warp.ts';
import {
  emptyProject, expandSelection, newSurface, newId, parseProject, sanitizeSurfacePatch,
  type Cue, type Project, type Scene, type Source, type Surface, type Shape, type Vec2, type ViewState, type TestPattern,
} from './project.ts';

export interface StoreState {
  project: Project;
  view: ViewState;
}

type Listener = (state: StoreState) => void;

/** Undo grouping. A corner drag fires dozens of mutations; they must collapse
 *  into one history entry or ctrl+Z becomes useless. Pass the same
 *  `coalesce` key for the whole gesture. */
export interface MutateOpts {
  history?: 'push' | 'none';
  coalesce?: string;
}

const HISTORY_LIMIT = 100;

/**
 * The single source of truth. Everything mutates through methods here, which
 * is what makes an OSC/MIDI bridge later a pure adapter: it calls the same
 * methods the editor calls.
 *
 * `subscribe` matches the Svelte store contract exactly (call immediately,
 * return an unsubscriber) so the editor can write `$store` with no adapter,
 * while this file stays free of any framework import.
 */
export class Store {
  #state: StoreState;
  #listeners = new Set<Listener>();
  #undo: Project[] = [];
  #redo: Project[] = [];
  #lastCoalesce: string | null = null;

  constructor(project: Project = emptyProject()) {
    this.#state = {
      project,
      view: {
        sourceRevisions: {},
        soloId: null,
        selectedIds: [],
        xray: false,
        playback: null,
        selectedCorner: null,
        selectedWarpPoint: null,
        testPattern: 'none',
        surfacePatterns: {},
        uiHidden: false,
      },
    };
  }

  get state(): StoreState { return this.#state; }
  get project(): Project { return this.#state.project; }
  get view(): ViewState { return this.#state.view; }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    fn(this.#state);
    return () => { this.#listeners.delete(fn); };
  }

  #emit(): void {
    for (const fn of this.#listeners) fn(this.#state);
  }

  /** Every project mutation funnels through here — history and notification
   *  happen in exactly one place. */
  mutate(fn: (draft: Project) => void, opts: MutateOpts = {}): void {
    const { history = 'push', coalesce } = opts;
    const before = this.#state.project;
    if (history === 'push') {
      const sameGesture = coalesce !== undefined && coalesce === this.#lastCoalesce;
      if (!sameGesture) {
        this.#undo.push(before);
        if (this.#undo.length > HISTORY_LIMIT) this.#undo.shift();
        this.#redo = [];
      }
      this.#lastCoalesce = coalesce ?? null;
    }
    const draft = structuredClone(before);
    fn(draft);
    this.#state = { ...this.#state, project: draft };
    this.#emit();
  }

  /** Ends a coalescing gesture so the next mutation starts a new history entry. */
  endGesture(): void { this.#lastCoalesce = null; }

  setView(patch: Partial<ViewState>): void {
    this.#state = { ...this.#state, view: { ...this.#state.view, ...patch } };
    this.#emit();
  }

  // --- project lifecycle ---------------------------------------------------

  load(json: unknown): void {
    const project = typeof json === 'string' ? parseProject(JSON.parse(json)) : parseProject(json);
    this.#undo = [];
    this.#redo = [];
    this.#lastCoalesce = null;
    this.#state = {
      project,
      view: {
        ...this.#state.view,
        sourceRevisions: {},
        selectedIds: [],
        xray: false,
        playback: null,
        selectedCorner: null,
        selectedWarpPoint: null,
        soloId: null,
      },
    };
    this.#emit();
  }

  toJSON(): string { return JSON.stringify(this.#state.project, null, 2); }

  setOutputSize(width: number, height: number): void {
    this.mutate((p) => { p.output = { width, height }; });
  }

  // --- history -------------------------------------------------------------

  undo(): void {
    const prev = this.#undo.pop();
    if (!prev) return;
    this.#redo.push(this.#state.project);
    this.#lastCoalesce = null;
    this.#state = { ...this.#state, project: prev };
    this.#emit();
  }

  redo(): void {
    const next = this.#redo.pop();
    if (!next) return;
    this.#undo.push(this.#state.project);
    this.#lastCoalesce = null;
    this.#state = { ...this.#state, project: next };
    this.#emit();
  }

  get canUndo(): boolean { return this.#undo.length > 0; }
  get canRedo(): boolean { return this.#redo.length > 0; }

  // --- surfaces ------------------------------------------------------------

  addSurface(surface?: Surface): Surface {
    const s = surface ?? newSurface(this.#state.project);
    this.mutate((p) => { p.surfaces.push(s); });
    this.setView({ selectedIds: [s.id], selectedCorner: null, selectedWarpPoint: null });
    return s;
  }

  // --- seleção -------------------------------------------------------------

  /**
   * Troca a seleção inteira. Ids inexistentes caem fora e vínculos são puxados
   * para dentro, então nada além deste método precisa saber que vínculo existe.
   */
  setSelection(ids: readonly string[]): void {
    const next = expandSelection(this.#state.project, ids);
    this.setView({ selectedIds: next, selectedCorner: null, selectedWarpPoint: null });
  }

  /**
   * Acrescenta ou tira uma superfície da seleção — o clique com modificador.
   *
   * Tirar remove o grupo inteiro quando a superfície é ligada: metade de um
   * vínculo selecionado é um estado que o operador não pediu e não consegue ver.
   */
  toggleSelection(id: string): void {
    const current = this.#state.view.selectedIds;
    const group = expandSelection(this.#state.project, [id]);
    if (group.length === 0) return;

    const inside = group.every((x) => current.includes(x));
    const next = inside
      ? current.filter((x) => !group.includes(x))
      : [...current.filter((x) => !group.includes(x)), ...group];
    this.setView({ selectedIds: next, selectedCorner: null, selectedWarpPoint: null });
  }

  /**
   * Move tudo que está selecionado, numa mutação só.
   *
   * Uma só porque um arrasto de grupo é um gesto, e desfazer tem que devolver o
   * gesto inteiro — não uma superfície por vez. Superfície travada não anda e
   * também não segura as outras: travar fala sobre ela, nunca sobre o grupo.
   */
  moveSelection(dx: number, dy: number): void {
    const ids = this.#state.view.selectedIds.filter((id) => this.#editable(id));
    if (ids.length === 0) return;
    this.mutate((p) => {
      for (const s of p.surfaces) {
        if (!ids.includes(s.id)) continue;
        for (const c of s.frame) { c.x += dx; c.y += dy; }
      }
    }, { coalesce: `move:${ids.join(',')}` });
  }

  // --- timeline ------------------------------------------------------------

  /**
   * Tira uma foto da apresentação **do projeto** — o que foi montado à mão.
   *
   * Nunca do que a timeline está mostrando: capturar no meio de uma transição
   * guardaria um estado intermediário que ninguém pediu.
   */
  captureScene(name: string): void {
    const cues: Record<string, Cue> = {};
    for (const s of this.#state.project.surfaces) {
      cues[s.id] = { sourceId: s.sourceId, opacity: s.opacity, visible: s.visible };
    }
    const scene: Scene = { id: newId('scene'), name, cues, hold: 5, fade: 1 };
    this.mutate((p) => {
      p.timeline ??= { scenes: [], loop: false };
      p.timeline.scenes.push(scene);
    });
  }

  removeScene(id: string): void {
    this.mutate((p) => {
      if (!p.timeline) return;
      p.timeline.scenes = p.timeline.scenes.filter((s) => s.id !== id);
      // Timeline vazia é removida do projeto: assim quem apagou a última cena
      // volta a ter um arquivo sem a chave, como antes de existir a feature.
      if (p.timeline.scenes.length === 0) delete p.timeline;
    });
    this.#clampPlayback();
  }

  patchScene(id: string, patch: Partial<Pick<Scene, 'name' | 'hold' | 'fade'>>): void {
    this.mutate((p) => {
      const scene = p.timeline?.scenes.find((s) => s.id === id);
      if (!scene) return;
      if (patch.name !== undefined && patch.name.trim() !== '') scene.name = patch.name;
      if (patch.hold !== undefined) scene.hold = Math.max(0, patch.hold);
      if (patch.fade !== undefined) scene.fade = Math.max(0, patch.fade);
    }, { coalesce: `scene:${id}` });
  }

  moveScene(id: string, to: number): void {
    this.mutate((p) => {
      const scenes = p.timeline?.scenes;
      if (!scenes) return;
      const from = scenes.findIndex((s) => s.id === id);
      const scene = scenes[from];
      if (from < 0 || !scene) return;
      scenes.splice(from, 1);
      scenes.splice(Math.max(0, Math.min(scenes.length, to)), 0, scene);
    });
  }

  setLoop(loop: boolean): void {
    this.mutate((p) => { if (p.timeline) p.timeline.loop = loop; });
  }

  /**
   * Estaciona a timeline numa cena, tocando ou não.
   *
   * Passa por `setView`, que não clona projeto nem empilha histórico — é o que
   * faz tocar um show de quatro horas não escrever nada. AC-85.
   */
  goToScene(index: number, opts: { playing?: boolean } = {}): void {
    const scenes = this.#state.project.timeline?.scenes;
    if (!scenes?.length) return;
    const current = this.#state.view.playback;
    this.setView({
      playback: {
        sceneIndex: Math.max(0, Math.min(scenes.length - 1, index)),
        fromIndex: current?.sceneIndex ?? null,
        since: Date.now(),
        playing: opts.playing ?? current?.playing ?? false,
      },
    });
  }

  play(): void {
    const playback = this.#state.view.playback;
    if (!playback) { this.goToScene(0, { playing: true }); return; }
    this.setView({ playback: { ...playback, playing: true } });
  }

  pause(): void {
    const playback = this.#state.view.playback;
    if (playback) this.setView({ playback: { ...playback, playing: false } });
  }

  /** Devolve o comando ao que está no projeto. */
  eject(): void {
    if (this.#state.view.playback) this.setView({ playback: null });
  }

  /**
   * Avança se a cena corrente já venceu. Chamado por um relógio de fora — o
   * store não tem laço próprio, e não deveria ter.
   *
   * `hold: 0` **espera o GO**: uma cena que segura para sempre é como se diz
   * "pare aqui até alguém mandar seguir".
   */
  advanceIfDue(): void {
    const { view, project } = this.#state;
    const playback = view.playback;
    const scenes = project.timeline?.scenes;
    if (!playback?.playing || !scenes?.length) return;
    const scene = scenes[playback.sceneIndex];
    if (!scene || scene.hold <= 0) return;

    const elapsed = (Date.now() - playback.since) / 1000;
    if (elapsed < scene.fade + scene.hold) return;

    const next = playback.sceneIndex + 1;
    if (next < scenes.length) { this.goToScene(next, { playing: true }); return; }
    if (project.timeline?.loop) { this.goToScene(0, { playing: true }); return; }
    this.pause();
  }

  /** Uma cena apagada pode ter deixado o playhead fora do fim da lista. */
  #clampPlayback(): void {
    const playback = this.#state.view.playback;
    const scenes = this.#state.project.timeline?.scenes;
    if (!playback) return;
    if (!scenes?.length) { this.setView({ playback: null }); return; }
    if (playback.sceneIndex < scenes.length) return;
    this.setView({ playback: { ...playback, sceneIndex: scenes.length - 1, fromIndex: null } });
  }

  /**
   * Mexer na apresentação com uma timeline ativa devolve o controle à mão — o
   * idioma que qualquer mesa de luz tem.
   *
   * Sem isso, o controle de opacidade do inspetor não faria nada e ninguém
   * saberia por quê. Mexer em **geometria** não ejeta nada: corrigir alinhamento
   * com o show rodando é justamente a razão de cena não guardar geometria.
   */
  #takeManualControl(): void {
    if (this.#state.view.playback) this.eject();
  }

  // --- vínculo -------------------------------------------------------------

  /** Liga as superfícies selecionadas num grupo só. Menos de duas não é grupo. */
  linkSelected(): void {
    const ids = [...this.#state.view.selectedIds];
    if (ids.length < 2) return;
    const link = newId('link');
    this.mutate((p) => {
      for (const s of p.surfaces) if (ids.includes(s.id)) s.link = link;
    });
  }

  /** Desfaz o vínculo das selecionadas, deixando a seleção como está: quem
   *  desagrupa normalmente quer continuar mexendo nas mesmas superfícies. */
  unlinkSelected(): void {
    const ids = [...this.#state.view.selectedIds];
    if (ids.length === 0) return;
    this.mutate((p) => {
      for (const s of p.surfaces) if (ids.includes(s.id)) delete s.link;
    });
  }

  removeSurface(id: string): void {
    this.mutate((p) => { p.surfaces = p.surfaces.filter((s) => s.id !== id); });
    const { [id]: _dropped, ...surfacePatterns } = this.#state.view.surfacePatterns;
    const patch: Partial<ViewState> = { surfacePatterns };
    // An orphan override would resurface on a future surface reusing the id.
    const selectedIds = this.#state.view.selectedIds.filter((x) => x !== id);
    if (selectedIds.length !== this.#state.view.selectedIds.length) {
      patch.selectedIds = selectedIds;
      patch.selectedCorner = null;
      patch.selectedWarpPoint = null;
    }
    if (this.#state.view.soloId === id) patch.soloId = null;
    this.setView(patch);
  }

  /** `name` lets the host localise the copy's name; the default stays English,
   *  like every other value the engine invents on its own. */
  duplicateSurface(id: string, name?: string): void {
    const src = this.#state.project.surfaces.find((s) => s.id === id);
    if (!src) return;
    const copy = structuredClone(src);
    copy.id = newId('surf');
    copy.name = name ?? `${src.name} copy`;
    copy.z = this.#state.project.surfaces.length + 1;
    // Offset so the copy is grabbable instead of hiding exactly behind the original.
    for (const c of copy.frame) { c.x += 24; c.y += 24; }
    this.addSurface(copy);
  }

  /** Locked surfaces reject geometry edits — this is the guard that makes the
   *  lock affordance real, and it lives here so every caller inherits it. */
  #editable(id: string): boolean {
    const s = this.#state.project.surfaces.find((x) => x.id === id);
    return !!s && !s.locked;
  }

  /**
   * The single write path for a surface.
   *
   * Every field goes through `sanitizeSurfacePatch`, so a clamp cannot depend on
   * which method the caller reached for — including the external-control bridge
   * this class exists to make possible.
   */
  patchSurface(id: string, patch: Partial<Surface>, opts?: MutateOpts): void {
    const locked = !this.#editable(id);
    this.mutate((p) => {
      const s = p.surfaces.find((x) => x.id === id);
      if (!s) return;
      Object.assign(s, sanitizeSurfacePatch(patch, { locked }));
    }, opts);
  }

  setCorner(id: string, corner: number, pos: Vec2): void {
    if (!this.#editable(id)) return;
    this.mutate((p) => {
      const s = p.surfaces.find((x) => x.id === id);
      if (s && s.frame[corner]) s.frame[corner] = { x: pos.x, y: pos.y };
    }, { coalesce: `corner:${id}:${corner}` });
  }

  nudgeCorner(id: string, corner: number, dx: number, dy: number): void {
    if (!this.#editable(id)) return;
    this.mutate((p) => {
      const s = p.surfaces.find((x) => x.id === id);
      const c = s?.frame[corner];
      if (c) { c.x += dx; c.y += dy; }
    }, { coalesce: `nudge:${id}:${corner}` });
  }

  moveSurface(id: string, dx: number, dy: number): void {
    if (!this.#editable(id)) return;
    this.mutate((p) => {
      const s = p.surfaces.find((x) => x.id === id);
      if (!s) return;
      for (const c of s.frame) { c.x += dx; c.y += dy; }
    }, { coalesce: `move:${id}` });
  }

  setSurfaceFrame(id: string, corners: [Vec2, Vec2, Vec2, Vec2]): void {
    if (!this.#editable(id)) return;
    this.mutate((p) => {
      const s = p.surfaces.find((x) => x.id === id);
      if (s) s.frame = structuredClone(corners);
    });
  }

  /** Recorte dentro da fonte, em 0..1. Mescla com o que já existe, para o
   *  editor poder mandar um campo só. */
  setCrop(id: string, crop: Partial<Surface['crop']>): void {
    const current = this.#state.project.surfaces.find((x) => x.id === id)?.crop;
    if (!current) return;
    this.patchSurface(id, { crop: { ...current, ...crop } }, { coalesce: `crop:${id}` });
  }

  /**
   * Moves one vertex of a traced polygon, in frame space.
   *
   * Locked applies here for the same reason it applies to a corner: the shape
   * is what sits on the physical object, and nudging it is as destructive as
   * nudging the frame.
   */
  setPolygonPoint(id: string, index: number, point: Vec2): void {
    if (!this.#editable(id)) return;
    this.mutate((p) => {
      const s = p.surfaces.find((x) => x.id === id);
      if (s?.shape.kind !== 'polygon') return;
      const target = s.shape.points[index];
      if (!target) return;
      s.shape.points[index] = { x: point.x, y: point.y };
    }, { coalesce: `poly:${id}:${index}` });
  }

  // --- warp ----------------------------------------------------------------

  /** Liga a malha, começando na grade identidade — que desenha exatamente o
   *  mesmo que não ter malha nenhuma. */
  enableWarp(id: string, cols = DEFAULT_CELLS, rows = DEFAULT_CELLS): void {
    if (this.#surface(id)?.warp) return;
    this.patchSurface(id, { warp: identityWarp(cols, rows) });
  }

  /** Remover é a única operação de malha que o patch genérico não expressa —
   *  `Partial<Surface>` sabe dizer "este valor", não "nenhum valor". */
  disableWarp(id: string): void {
    if (!this.#editable(id)) return;
    this.mutate((p) => {
      const surface = p.surfaces.find((x) => x.id === id);
      if (surface) delete surface.warp;
    });
  }

  /** Volta à grade identidade sem desligar a malha. */
  resetWarp(id: string): void {
    const warp = this.#surface(id)?.warp;
    if (!warp) return;
    this.patchSurface(id, { warp: identityWarp(warp.cols, warp.rows, warp.interpolation) });
  }

  /** Empurra um ponto de controle em unidades do frame — o equivalente de malha
   *  ao ajuste de 1 px que as setas fazem num canto. */
  nudgeWarpPoint(id: string, index: number, dx: number, dy: number, falloff = 0): void {
    const current = this.#surface(id)?.warp?.points[index];
    if (!current) return;
    this.setWarpPoint(id, index, { x: current.x + dx, y: current.y + dy }, falloff);
  }

  /**
   * Move um ponto de controle, em espaço do frame.
   *
   * `falloff` arrasta os vizinhos junto, com peso que cai com a distância na
   * grade. Sem isso, moldar uma curva vira um ponto de cada vez — que é o que
   * separa uma malha usável de uma malha que existe.
   */
  setWarpPoint(id: string, index: number, point: Vec2, falloff = 0): void {
    const warp = this.#surface(id)?.warp;
    if (!warp || !warp.points[index]) return;

    const cols = warp.cols + 1;
    const target = { col: index % cols, row: Math.floor(index / cols) };
    const dx = point.x - warp.points[index]!.x;
    const dy = point.y - warp.points[index]!.y;

    const points = warp.points.map((p, i) => {
      if (i === index) return { x: point.x, y: point.y };
      if (falloff <= 0) return p;
      const distance = Math.hypot((i % cols) - target.col, Math.floor(i / cols) - target.row);
      if (distance > falloff) return p;
      // Smoothstep so the pulled area has no hard edge at the radius.
      const t = 1 - distance / falloff;
      const weight = t * t * (3 - 2 * t);
      return { x: p.x + dx * weight, y: p.y + dy * weight };
    });

    this.patchSurface(id, { warp: { ...warp, points } }, { coalesce: `warp:${id}:${index}` });
  }

  /** Troca a subdivisão preservando a superfície já ajustada. */
  setWarpGrid(id: string, cols: number, rows: number): void {
    const warp = this.#surface(id)?.warp;
    if (!warp) return;
    this.patchSurface(id, { warp: resampleWarp(warp, cols, rows) });
  }

  setWarpInterpolation(id: string, interpolation: WarpInterpolation): void {
    const warp = this.#surface(id)?.warp;
    if (!warp) return;
    this.patchSurface(id, { warp: { ...warp, interpolation } });
  }

  #surface(id: string): Surface | undefined {
    return this.#state.project.surfaces.find((s) => s.id === id);
  }

  setSurfaceShape(id: string, shape: Shape): void {
    this.patchSurface(id, { shape });
  }

  setSurfaceSource(id: string, sourceId: string | null): void {
    this.#takeManualControl();
    this.patchSurface(id, { sourceId });
  }

  toggleLock(id: string): void {
    const s = this.#state.project.surfaces.find((x) => x.id === id);
    if (s) this.patchSurface(id, { locked: !s.locked });
  }

  toggleVisible(id: string): void {
    const s = this.#state.project.surfaces.find((x) => x.id === id);
    if (!s) return;
    this.#takeManualControl();
    this.patchSurface(id, { visible: !s.visible });
  }

  toggleSolo(id: string): void {
    this.setView({ soloId: this.#state.view.soloId === id ? null : id });
  }

  /** Spins the content inside the frame. The frame itself, and therefore the
   *  alignment with the physical object, is untouched — so this is safe on a
   *  locked surface, unlike anything that moves a corner. */
  setRotation(id: string, degrees: number): void {
    this.patchSurface(id, { rotation: degrees }, { coalesce: `rotation:${id}` });
  }

  setOpacity(id: string, opacity: number): void {
    this.#takeManualControl();
    this.patchSurface(id, { opacity }, { coalesce: `opacity:${id}` });
  }

  reorder(id: string, z: number): void {
    this.patchSurface(id, { z });
  }

  // --- sources -------------------------------------------------------------

  addSource(source: Source): Source {
    this.mutate((p) => { p.sources.push(source); });
    return source;
  }

  removeSource(id: string): void {
    this.mutate((p) => {
      p.sources = p.sources.filter((s) => s.id !== id);
      for (const s of p.surfaces) if (s.sourceId === id) s.sourceId = null;
    });
  }

  patchSource(id: string, patch: Partial<Source>): void {
    this.mutate((p) => {
      const s = p.sources.find((x) => x.id === id);
      if (s) Object.assign(s, patch);
    });
  }

  /**
   * Operações nomeadas por tipo de fonte.
   *
   * `Source` é união discriminada, e `Partial<Source>` num `patchSource` obriga
   * o chamador a um cast — que desliga exatamente a checagem que a união existe
   * para dar. Estreitar aqui dentro, uma vez, tira o cast de todos os
   * chamadores e faz o compilador recusar `rgb` numa câmera.
   */
  setSourceColor(id: string, rgb: [number, number, number]): void {
    this.#patchByKind(id, 'color', (s) => { s.rgb = rgb; });
  }

  setCameraDevice(id: string, deviceId: string): void {
    this.#patchByKind(id, 'camera', (s) => { s.deviceId = deviceId; });
  }

  /** Aponta uma fonte de arquivo para outro arquivo — o "religar" do editor. */
  relinkSource(id: string, path: string): void {
    const source = this.#state.project.sources.find((s) => s.id === id);
    if (!source || !['canvas', 'image', 'gif', 'video'].includes(source.kind)) return;
    const revisions = this.#state.view.sourceRevisions;
    this.setView({ sourceRevisions: { ...revisions, [id]: (revisions[id] ?? 0) + 1 } });
    this.mutate((p) => {
      const s = p.sources.find((x) => x.id === id);
      if (!s) return;
      if (s.kind === 'canvas') s.moduleId = path;
      else if (s.kind === 'image' || s.kind === 'gif' || s.kind === 'video') s.path = path;
    });
  }

  #patchByKind<K extends Source['kind']>(
    id: string,
    kind: K,
    apply: (source: Extract<Source, { kind: K }>) => void,
  ): void {
    this.mutate((p) => {
      const s = p.sources.find((x) => x.id === id);
      if (s?.kind === kind) apply(s as Extract<Source, { kind: K }>);
    });
  }

  /** Global pattern, for every surface without an override. */
  setTestPattern(pattern: TestPattern): void {
    this.setView({ testPattern: pattern });
  }

  /** This surface only. `null` hands control back to the global pattern. */
  setSurfacePattern(id: string, pattern: TestPattern | null): void {
    const next = { ...this.#state.view.surfacePatterns };
    if (pattern === null) delete next[id];
    else next[id] = pattern;
    this.setView({ surfacePatterns: next });
  }
}

/**
 * The pattern in force for a surface: its own if it has one, else the global.
 *
 * Aligning happens one surface at a time — grid on this, number on that, none
 * elsewhere. The global one stays because "grid on everything" is the common
 * case, and switching each surface on by hand would be worse.
 */
export function patternFor(state: StoreState, surfaceId: string): TestPattern {
  return state.view.surfacePatterns[surfaceId] ?? state.view.testPattern;
}

/** Surfaces the renderer should draw, in z order, honouring solo and visible. */
/**
 * As superfícies que o renderer vai desenhar, na ordem certa.
 *
 * Filtra, **nunca copia**: o renderer guarda geometria derivada num
 * `WeakMap<Surface, …>` com a identidade do objeto como chave, e clonar aqui
 * furaria esse cache a cada frame. AC-92.
 */
export function visibleSurfaces(state: StoreState): Surface[] {
  const { project, view } = state;
  const list = view.soloId
    ? project.surfaces.filter((s) => s.id === view.soloId)
    : project.surfaces.filter((s) => presentationOf(state, s).visible);
  return [...list].sort((a, b) => a.z - b.z);
}

/** Quanto tempo faz que a cena corrente começou, em segundos. */
function elapsedOf(view: ViewState): number {
  return view.playback ? Math.max(0, (Date.now() - view.playback.since) / 1000) : 0;
}

/** A cena em que a timeline está estacionada ou tocando, se houver. */
export function currentScene(state: StoreState): Scene | null {
  const { playback } = state.view;
  const scenes = state.project.timeline?.scenes;
  if (!playback || !scenes?.length) return null;
  return scenes[Math.min(playback.sceneIndex, scenes.length - 1)] ?? null;
}

/**
 * Uma transição está acontecendo agora?
 *
 * É isto, e não "a timeline está tocando", que mantém o laço de render acordado:
 * uma cena parada com conteúdo parado não tem por que segurar a GPU a 60fps.
 */
export function isFading(state: StoreState): boolean {
  const scene = currentScene(state);
  return !!scene && scene.fade > 0 && elapsedOf(state.view) < scene.fade;
}

/**
 * O que uma superfície está mostrando **agora**.
 *
 * Sem timeline, é o que está no projeto. Com timeline, a cena ganha — e a
 * sobreposição acontece aqui, na leitura, sem escrever nada. É o mesmo lugar por
 * onde solo e padrão de teste já passam.
 *
 * A transição escurece até o preto na primeira metade, ainda mostrando o
 * conteúdo velho, e volta ao alvo na segunda, já com o novo. Um crossfade de
 * verdade exigiria duas texturas por superfície; quem precisar de um empilha
 * duas superfícies e cruza as opacidades pela cena.
 */
export function presentationOf(state: StoreState, surface: Surface): Cue {
  const own: Cue = { sourceId: surface.sourceId, opacity: surface.opacity, visible: surface.visible };
  const scene = currentScene(state);
  // Cena é sobreposição, não estado completo do mundo: superfície criada depois
  // da captura mantém o que tem em vez de sumir.
  const cue = scene?.cues[surface.id];
  if (!scene || !cue) return own;

  if (scene.fade <= 0) return cue;

  const elapsed = elapsedOf(state.view);
  if (elapsed >= scene.fade) return cue;

  const half = scene.fade / 2;
  if (elapsed < half) {
    // Primeira metade: o que estava na tela, escurecendo. "O que estava" é a
    // cena de onde se saiu — não o projeto — senão pular de cena mostraria por
    // meio segundo um conteúdo que ninguém pediu.
    const from = state.view.playback?.fromIndex;
    const previous = from === null || from === undefined
      ? own
      : state.project.timeline?.scenes[from]?.cues[surface.id] ?? own;
    return { ...previous, opacity: previous.opacity * (1 - elapsed / half) };
  }
  // Segunda metade: o novo subindo do preto.
  return { ...cue, opacity: cue.opacity * ((elapsed - half) / half) };
}
