import type { Vec2 } from '../math/homography.ts';
import { parseWarp, type Warp } from './warp.ts';

export type { Vec2 };

export type Source =
  | { id: string; name: string; kind: 'image'; path: string }
  | { id: string; name: string; kind: 'video'; path: string; loop: boolean; muted: boolean; rate: number }
  | { id: string; name: string; kind: 'gif'; path: string }
  | { id: string; name: string; kind: 'color'; rgb: [number, number, number] }
  | { id: string; name: string; kind: 'capture' }
  | { id: string; name: string; kind: 'camera'; deviceId?: string }
  | { id: string; name: string; kind: 'canvas'; moduleId: string }
  | ({ id: string; name: string; kind: 'text' } & TextStyle);

/**
 * Como um texto é desenhado.
 *
 * Não há campo de corpo: a textura é a caixa do próprio texto, e o
 * enquadramento da superfície decide como ela cai na forma. Um tamanho em
 * pixels aqui seria um segundo controle brigando com o primeiro.
 *
 * Também não há cor de fundo. Preto é ausência de luz nesta ferramenta, então o
 * fundo já é transparente — quem quiser uma caixa atrás põe uma superfície de
 * cor embaixo.
 */
export interface TextStyle {
  text: string;
  /** Pilhas de fonte do sistema, e não uma lista de fontes: o aplicativo é um
   *  arquivo único que abre sem rede, e embutir tipografia o inflaria. */
  family: TextFamily;
  weight: 400 | 700;
  italic: boolean;
  color: [number, number, number];
  align: TextAlign;
  /** Múltiplo do corpo. */
  lineHeight: number;
  /** Espaçamento entre letras, em `em`. */
  tracking: number;
}

export type TextFamily = 'sans' | 'serif' | 'mono';
export type TextAlign = 'left' | 'center' | 'right';

export const TEXT_FAMILIES: readonly TextFamily[] = ['sans', 'serif', 'mono'];
export const TEXT_ALIGNS: readonly TextAlign[] = ['left', 'center', 'right'];

export const DEFAULT_TEXT: TextStyle = {
  text: '',
  family: 'sans',
  weight: 700,
  italic: false,
  color: [255, 255, 255],
  align: 'center',
  lineHeight: 1.15,
  tracking: 0,
};

export type SourceKind = Source['kind'];

export type Shape =
  | { kind: 'quad' }
  | { kind: 'ellipse'; feather: number }
  | { kind: 'polygon'; points: Vec2[] }; // normalised 0..1 in frame space

export type Fit = 'stretch' | 'contain' | 'cover';
export type Blend = 'normal' | 'add' | 'screen' | 'multiply';

export interface Surface {
  id: string;
  name: string;
  frame: [Vec2, Vec2, Vec2, Vec2]; // TL, TR, BR, BL — output pixels
  shape: Shape;
  sourceId: string | null;
  crop: { x: number; y: number; w: number; h: number }; // 0..1 inside the source
  /**
   * Optional free-form deformation between the frame and the shape.
   *
   * Absent means "no warp", which is the common case and keeps every project
   * ever saved byte-identical. It is a layer of its own rather than another
   * `Shape`, so that a warped surface can still carry an ellipse or a polygon
   * mask — those live in the same undeformed frame space and ride along.
   */
  warp?: Warp;
  /**
   * Vínculo com outras superfícies: as que compartilham este id se selecionam e
   * se movem juntas.
   *
   * Opcional pelo mesmo motivo de `warp`: projeto salvo sem vínculo continua
   * idêntico byte a byte. É uma decisão do operador, nunca uma inferência a
   * partir de posição ou nome.
   */
  link?: string;
  fit: Fit;
  /** Content rotation inside the frame, in degrees clockwise. The frame keeps
   *  the perspective; this only spins what is sampled into it. */
  rotation: number;
  opacity: number;
  blend: Blend;
  locked: boolean;
  visible: boolean;
  z: number;
}

/**
 * O que uma cena guarda de uma superfície.
 *
 * **Apresentação, nunca geometria.** O alinhamento custou horas em cima de uma
 * escada e é físico; rodar o show não pode, por construção, mexer nele. O efeito
 * colateral é o que torna a regra valiosa: dá para corrigir alinhamento com o
 * show rodando.
 */
export interface Cue {
  sourceId: string | null;
  opacity: number;
  visible: boolean;
}

export interface Scene {
  id: string;
  name: string;
  /** Por id de superfície. Ausência é deliberada: cena é uma sobreposição, não
   *  um estado completo do mundo — uma superfície criada depois mantém o que
   *  tem em vez de sumir. */
  cues: Record<string, Cue>;
  /** Segundos que a cena segura depois da transição. **Zero espera o GO.** */
  hold: number;
  /** Transição de entrada, em segundos. Zero é corte seco. */
  fade: number;
}

export interface Timeline {
  scenes: Scene[];
  loop: boolean;
}

export interface Project {
  version: 1;
  output: { width: number; height: number };
  sources: Source[];
  surfaces: Surface[];
  /** Opcional pelo mesmo motivo de `warp` e `link`: projeto sem show continua
   *  byte a byte idêntico ao que era antes desta feature existir. */
  timeline?: Timeline;
}

/** Non-persisted view state: solo lives here because it is a rehearsal aid,
 *  not part of the show. DECISION: keeping it out of Project means reopening a
 *  folder never leaves you staring at a single soloed surface. */
export interface ViewState {
  /** Session-only reload requests, including replacements at the same path. */
  sourceRevisions: Record<string, number>;
  soloId: string | null;
  /**
   * Quem está selecionado agora, em ordem de escolha.
   *
   * Uma lista, e não um id mais um conjunto: dois campos exigiriam manter um
   * invariante entre eles, e o âncora — a superfície que o inspetor edita e cujo
   * canto as setas movem — é sempre o **último** escolhido. Ver `anchorId`.
   */
  selectedIds: string[];
  selectedCorner: number | null;
  /** Índice do ponto de controle selecionado, para as setas do teclado. */
  selectedWarpPoint: number | null;
  /**
   * Diagnóstico do editor: apaga o conteúdo e acende a estrutura.
   *
   * Mora aqui, e não no `Project`, porque é auxílio de ensaio (ADR-0013) — e é
   * desenhado no overlay, que a janela de saída não tem. Não é uma trava contra
   * vazar para o projetor: é impossibilidade estrutural.
   */
  xray: boolean;
  /**
   * Onde a timeline está agora. Fora do `Project` porque posição de playhead não
   * é parte do show salvo.
   *
   * `since` é `Date.now()`, e não `performance.now()`: o editor e a janela de
   * saída são duas janelas com origens de tempo diferentes lendo o mesmo store.
   *
   * Guardar o **instante de início** em vez do tempo decorrido é o que faz tocar
   * não custar escrita nenhuma: o decorrido é calculado na hora de desenhar.
   */
  playback: {
    sceneIndex: number;
    /** De onde a transição está saindo. `null` quando a timeline acabou de
     *  entrar: aí ela sai do que está no projeto. Sem este campo a primeira
     *  metade da transição escureceria o valor do projeto em vez do que estava
     *  de fato na tela — errado sempre que se pula de cena ou o laço volta. */
    fromIndex: number | null;
    since: number;
    playing: boolean;
  } | null;
  /** Applies to every surface without one of its own. */
  testPattern: TestPattern;
  /** Per-surface override, by id. Absence means "follow the global one", and an
   *  explicit `'none'` blanks the pattern on that surface alone. */
  surfacePatterns: Record<string, TestPattern>;
  uiHidden: boolean;
}

/**
 * A superfície cujas propriedades a interface edita: a última escolhida.
 *
 * Editar sempre vale para uma; mover vale para todas. Confundir as duas é o erro
 * clássico aqui, e por isso o âncora tem nome próprio.
 */
export function anchorId(view: ViewState): string | null {
  return view.selectedIds[view.selectedIds.length - 1] ?? null;
}

/**
 * A seleção depois de puxar os vínculos: superfície ligada vem junto.
 *
 * Vínculo é do projeto e seleção é do momento — esta função é onde os dois se
 * encontram, e o único lugar onde essa expansão acontece.
 */
export function expandSelection(project: Project, ids: readonly string[]): string[] {
  const byId = new Map(project.surfaces.map((s) => [s.id, s]));
  const out: string[] = [];
  const push = (id: string): void => { if (!out.includes(id)) out.push(id); };

  for (const id of ids) {
    const surface = byId.get(id);
    if (!surface) continue; // id órfão nunca entra na seleção
    // As ligadas entram antes da pedida, para que a **pedida** fique por último
    // e vire o âncora: quem clicou numa superfície espera ver aquela no painel,
    // não uma irmã que o vínculo trouxe junto.
    if (surface.link) {
      for (const other of project.surfaces) {
        if (other.id !== id && other.link === surface.link) push(other.id);
      }
    }
    push(id);
  }
  return out;
}

export type TestPattern =
  | 'none' | 'grid' | 'number' | 'crosshair'
  | 'white' | 'black' | 'bars' | 'sweep';

let counter = 0;
/** Ids only need to be unique within a project, and projects are single-user
 *  files. ponytail: no uuid dependency; crypto.randomUUID when available. */
export function newId(prefix = 'id'): string {
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? (++counter).toString(36);
  return `${prefix}_${rand}`;
}

export function emptyProject(width = 1920, height = 1080): Project {
  return { version: 1, output: { width, height }, sources: [], surfaces: [] };
}

/** A fresh surface centred in the output, sized to a quarter of it. */
export function newSurface(project: Project, name?: string): Surface {
  const { width, height } = project.output;
  const w = width / 4;
  const h = height / 4;
  const cx = width / 2;
  const cy = height / 2;
  const n = project.surfaces.length + 1;
  return {
    id: newId('surf'),
    name: name ?? `Surface ${n}`,
    frame: [
      { x: cx - w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy + h / 2 },
      { x: cx - w / 2, y: cy + h / 2 },
    ],
    shape: { kind: 'quad' },
    sourceId: null,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    fit: 'stretch',
    rotation: 0,
    opacity: 1,
    blend: 'normal',
    locked: false,
    visible: true,
    z: n,
  };
}

const DEFAULT_SURFACE = {
  shape: { kind: 'quad' } as Shape,
  sourceId: null,
  crop: { x: 0, y: 0, w: 1, h: 1 },
  fit: 'stretch' as Fit,
  rotation: 0,
  opacity: 1,
  blend: 'normal' as Blend,
  locked: false,
  visible: true,
  z: 0,
};

/**
 * The one place a partial edit to a surface is made legal.
 *
 * Before this existed the class had two kinds of write path: methods that
 * clamped (`setOpacity`, `setCrop`, `setRotation`) and a generic patch that did
 * not — so the same field was safe or unsafe depending on which method the
 * caller happened to pick. The external-control bridge the store exists for
 * would have used exactly the unsafe one.
 *
 * `locked` drops geometry only. Changing the clipping shape or the name of a
 * locked surface is a deliberate click, not the accidental bump the lock is
 * there to prevent.
 */
export function sanitizeSurfacePatch(
  patch: Partial<Surface>,
  { locked }: { locked: boolean },
): Partial<Surface> {
  const out: Partial<Surface> = {};

  if (patch.name !== undefined && patch.name.trim() !== '') out.name = patch.name;
  if (patch.sourceId !== undefined) out.sourceId = patch.sourceId;
  if (patch.shape !== undefined) out.shape = parseShape(patch.shape);
  if (patch.fit !== undefined) out.fit = oneOf(patch.fit, FITS, 'stretch');
  if (patch.blend !== undefined) out.blend = oneOf(patch.blend, BLENDS, 'normal');
  if (patch.locked !== undefined) out.locked = patch.locked;
  if (patch.visible !== undefined) out.visible = patch.visible;
  if (patch.opacity !== undefined) out.opacity = clamp(num(patch.opacity, 1), 0, 1);
  if (patch.rotation !== undefined) out.rotation = normalizeAngle(num(patch.rotation, 0));
  if (patch.z !== undefined) out.z = num(patch.z, 0);
  if (patch.crop !== undefined) out.crop = parseCrop(patch.crop);
  // A warp is geometry: the lock exists to stop exactly this from moving.
  // Removing one goes through `Store.disableWarp`, because a partial patch can
  // say "this value" but not "no value".
  if (!locked && patch.warp !== undefined) {
    const warp = parseWarp(patch.warp);
    if (warp) out.warp = warp;
  }

  // Geometry is the one thing the lock exists to protect.
  if (!locked && patch.frame !== undefined) {
    const frame = parseFrame(patch.frame);
    if (frame) out.frame = frame;
  }
  return out;
}

const FITS = ['stretch', 'contain', 'cover'] as const;
const BLENDS = ['normal', 'add', 'screen', 'multiply'] as const;

/**
 * Parse untrusted JSON into a Project, filling defaults and dropping garbage.
 *
 * This is a trust boundary: the input is a file on disk that a user may have
 * hand-edited or that an older build wrote. Anything unrecognised is dropped
 * rather than allowed to reach the renderer, where a NaN corner would blank
 * the projector mid-show.
 */
export function parseProject(raw: unknown): Project {
  if (!isRecord(raw)) throw new Error('project.json is not an object');
  const version = raw['version'];
  if (version !== 1) throw new Error(`unsupported project version: ${String(version)}`);

  const out = isRecord(raw['output']) ? raw['output'] : {};
  const project: Project = {
    version: 1,
    output: {
      width: num(out['width'], 1920),
      height: num(out['height'], 1080),
    },
    sources: asArray(raw['sources']).map(parseSource).filter((s): s is Source => s !== null),
    surfaces: [],
    ...parseOptionalTimeline(raw['timeline']),
  };

  // Duplicate source ids would collide in the texture pool, which is keyed by
  // id: the second one silently wins and both surfaces draw the same thing.
  // Later duplicates lose, because surfaces already reference the id.
  const sourceIds = new Set<string>();
  project.sources = project.sources.filter((s) => {
    if (sourceIds.has(s.id)) return false;
    sourceIds.add(s.id);
    return true;
  });

  const surfaceIds = new Set<string>();
  project.surfaces = asArray(raw['surfaces'])
    .map((s) => parseSurface(s, sourceIds))
    .filter((s): s is Surface => s !== null)
    .map((surface) => {
      // A duplicate surface id makes every lookup hit the wrong one and
      // `removeSurface` delete both. Nothing references a surface by id from
      // inside the file, so renaming the clash is lossless — unlike dropping it.
      if (!surfaceIds.has(surface.id)) {
        surfaceIds.add(surface.id);
        return surface;
      }
      const fresh = { ...surface, id: newId('surf') };
      surfaceIds.add(fresh.id);
      return fresh;
    });

  // As cues só podem ser podadas aqui, depois de existirem superfícies e fontes
  // para conferir contra. Cue de superfície que não existe mais é peso morto;
  // fonte pendurada vira "sem fonte", exatamente como em `parseSurface`, para a
  // cena não acender o padrão de mídia faltando em cima de um objeto físico.
  if (project.timeline) {
    for (const scene of project.timeline.scenes) {
      for (const [surfaceId, cue] of Object.entries(scene.cues)) {
        if (!surfaceIds.has(surfaceId)) {
          delete scene.cues[surfaceId];
          continue;
        }
        if (cue.sourceId && !sourceIds.has(cue.sourceId)) cue.sourceId = null;
      }
    }
  }
  return project;
}

function parseSource(raw: unknown): Source | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['id'], '');
  const kind = raw['kind'];
  if (!id || typeof kind !== 'string') return null;
  const name = str(raw['name'], id);
  switch (kind) {
    case 'image':
    case 'gif':
      return { id, name, kind, path: str(raw['path'], '') };
    case 'video':
      return {
        id, name, kind,
        path: str(raw['path'], ''),
        loop: bool(raw['loop'], true),
        muted: bool(raw['muted'], true),
        rate: num(raw['rate'], 1),
      };
    case 'text': {
      const raw_color = asArray(raw['color']).map((v) => clamp(num(v, 255), 0, 255));
      return {
        id, name, kind,
        text: str(raw['text'], ''),
        family: oneOf(raw['family'], TEXT_FAMILIES, 'sans'),
        weight: num(raw['weight'], 700) >= 550 ? 700 : 400,
        italic: bool(raw['italic'], false),
        color: [raw_color[0] ?? 255, raw_color[1] ?? 255, raw_color[2] ?? 255],
        align: oneOf(raw['align'], TEXT_ALIGNS, 'center'),
        // Entrelinha zero ou negativa empilharia as linhas umas sobre as outras.
        lineHeight: clamp(num(raw['lineHeight'], 1.15), 0.5, 4),
        tracking: clamp(num(raw['tracking'], 0), -0.5, 2),
      };
    }
    case 'color': {
      const rgb = asArray(raw['rgb']).map((v) => clamp(num(v, 0), 0, 255));
      return { id, name, kind, rgb: [rgb[0] ?? 255, rgb[1] ?? 255, rgb[2] ?? 255] };
    }
    case 'capture':
      return { id, name, kind };
    case 'camera': {
      const deviceId = str(raw['deviceId'], '');
      return deviceId ? { id, name, kind, deviceId } : { id, name, kind };
    }
    case 'canvas':
      return { id, name, kind, moduleId: str(raw['moduleId'], '') };
    default:
      return null;
  }
}

function parseSurface(raw: unknown, sourceIds: ReadonlySet<string>): Surface | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['id'], '');
  if (!id) return null;
  const frame = parseFrame(raw['frame']);
  if (!frame) return null;
  const sourceId = str(raw['sourceId'], '');
  return {
    ...DEFAULT_SURFACE,
    id,
    name: str(raw['name'], id),
    frame,
    shape: parseShape(raw['shape']),
    // A dangling source reference becomes "no source" — the surface then draws
    // the missing-media pattern instead of stale content.
    sourceId: sourceId && sourceIds.has(sourceId) ? sourceId : null,
    crop: parseCrop(raw['crop']),
    fit: oneOf(raw['fit'], FITS, 'stretch'),
    rotation: normalizeAngle(num(raw['rotation'], 0)),
    ...parseOptionalWarp(raw['warp']),
    ...parseOptionalLink(raw['link']),
    opacity: clamp(num(raw['opacity'], 1), 0, 1),
    blend: oneOf(raw['blend'], BLENDS, 'normal'),
    locked: bool(raw['locked'], false),
    visible: bool(raw['visible'], true),
    z: num(raw['z'], 0),
  };
}

/** Spread-friendly: an absent or unrecoverable warp adds no key at all. */
/**
 * Uma timeline ausente continua ausente — projeto sem show fica idêntico.
 *
 * Cue com id de superfície que não existe mais é descartado na leitura: uma cue
 * órfã voltaria a valer no dia em que um id fosse reutilizado, e aí uma cena
 * antiga apagaria uma superfície nova sem explicação.
 */
function parseOptionalTimeline(raw: unknown): { timeline?: Timeline } {
  if (!isRecord(raw)) return {};
  const scenes = asArray(raw['scenes'])
    .map(parseScene)
    .filter((s): s is Scene => s !== null);
  if (scenes.length === 0) return {};
  return { timeline: { scenes, loop: bool(raw['loop'], false) } };
}

function parseScene(raw: unknown): Scene | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['id'], '');
  if (!id) return null;
  const cues: Record<string, Cue> = {};
  const rawCues = isRecord(raw['cues']) ? raw['cues'] : {};
  for (const [surfaceId, value] of Object.entries(rawCues)) {
    if (!isRecord(value)) continue;
    const sourceId = str(value['sourceId'], '');
    cues[surfaceId] = {
      sourceId: sourceId || null,
      opacity: clamp(num(value['opacity'], 1), 0, 1),
      visible: bool(value['visible'], true),
    };
  }
  return {
    id,
    name: str(raw['name'], id),
    cues,
    hold: Math.max(0, num(raw['hold'], 0)),
    fade: Math.max(0, num(raw['fade'], 0)),
  };
}

/** Ausente continua ausente: um `link: undefined` escrito no JSON mudaria o
 *  arquivo de quem nunca ligou superfície nenhuma. */
function parseOptionalLink(raw: unknown): { link?: string } {
  const link = str(raw, '');
  return link ? { link } : {};
}

function parseOptionalWarp(raw: unknown): { warp?: Warp } {
  if (raw === undefined || raw === null) return {};
  const warp = parseWarp(raw);
  return warp ? { warp } : {};
}

function parseFrame(raw: unknown): [Vec2, Vec2, Vec2, Vec2] | null {
  const arr = asArray(raw);
  if (arr.length !== 4) return null;
  const pts = arr.map(parseVec2);
  if (pts.some((p) => p === null)) return null;
  return pts as [Vec2, Vec2, Vec2, Vec2];
}

function parseVec2(raw: unknown): Vec2 | null {
  if (!isRecord(raw)) return null;
  const x = num(raw['x'], NaN);
  const y = num(raw['y'], NaN);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function parseShape(raw: unknown): Shape {
  if (!isRecord(raw)) return { kind: 'quad' };
  if (raw['kind'] === 'ellipse') return { kind: 'ellipse', feather: clamp(num(raw['feather'], 0), 0, 1) };
  if (raw['kind'] === 'polygon') {
    const points = asArray(raw['points']).map(parseVec2).filter((p): p is Vec2 => p !== null);
    return points.length >= 3 ? { kind: 'polygon', points } : { kind: 'quad' };
  }
  return { kind: 'quad' };
}

/** Minimum sampling window. Zero width or height samples nothing at all, so the
 *  surface would go dark for a reason no one could see in the file. */
const MIN_CROP = 0.01;

function parseCrop(raw: unknown): { x: number; y: number; w: number; h: number } {
  if (!isRecord(raw)) return { x: 0, y: 0, w: 1, h: 1 };
  return {
    x: clamp(num(raw['x'], 0), 0, 1),
    y: clamp(num(raw['y'], 0), 0, 1),
    w: clamp(num(raw['w'], 1), MIN_CROP, 1),
    h: clamp(num(raw['h'], 1), MIN_CROP, 1),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}
/** Degrees folded into [0, 360). Keeps the UI slider and the shader in the same
 *  range no matter how many turns a caller accumulated. */
export function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
