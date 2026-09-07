import type { Source } from '../model/project.ts';
import { ColorSource } from './color.ts';
import { ImageSource } from './image.ts';
import { GifSource } from './gif.ts';
import { CanvasSource } from './canvas.ts';
import { TextSource } from './text.ts';
import { CameraSource, CaptureSource, FileVideoSource, VideoTextureSource } from './video.ts';
import type { SourceContext, TextureSource } from './types.ts';

export * from './types.ts';
export { ColorSource, ImageSource, GifSource, CanvasSource, TextSource, CaptureSource, CameraSource, FileVideoSource, VideoTextureSource };

export function createSource(desc: Source, ctx: SourceContext): TextureSource {
  switch (desc.kind) {
    case 'color': return new ColorSource(desc.rgb);
    case 'image': return new ImageSource(desc.path, ctx);
    case 'gif': return new GifSource(desc.path, ctx);
    case 'video': return new FileVideoSource(desc.path, ctx, { loop: desc.loop, muted: desc.muted, rate: desc.rate });
    case 'capture': return new CaptureSource();
    case 'camera': return new CameraSource(desc.deviceId);
    case 'canvas': return new CanvasSource(desc.moduleId, ctx);
    case 'text': return new TextSource(desc);
  }
}

/**
 * Live texture cache, keyed by source id — never by surface. One clip feeding
 * ten surfaces is one decode and one upload per frame.
 *
 * `sync` reconciles the cache against the project's source list: it rebuilds an
 * entry whose descriptor changed in a way the instance cannot absorb (a new
 * file path), and merely patches one it can (a colour, a playback rate).
 */
export class SourcePool {
  #entries = new Map<string, { desc: Source; source: TextureSource; revision: number }>();
  #ctx: SourceContext;

  constructor(ctx: SourceContext) { this.#ctx = ctx; }

  sync(gl: WebGL2RenderingContext, descs: readonly Source[], revisions: Readonly<Record<string, number>> = {}): void {
    const seen = new Set<string>();
    for (const desc of descs) {
      seen.add(desc.id);
      const existing = this.#entries.get(desc.id);
      const revision = revisions[desc.id] ?? 0;
      if (!existing || existing.revision !== revision) {
        existing?.source.dispose(gl);
        this.#entries.set(desc.id, { desc, source: createSource(desc, this.#ctx), revision });
        continue;
      }
      if (existing.desc === desc) continue;
      if (this.#patch(existing.source, existing.desc, desc)) {
        existing.desc = desc;
      } else {
        existing.source.dispose(gl);
        this.#entries.set(desc.id, { desc, source: createSource(desc, this.#ctx), revision });
      }
    }
    for (const [id, entry] of this.#entries) {
      if (!seen.has(id)) {
        entry.source.dispose(gl);
        this.#entries.delete(id);
      }
    }
  }

  /** Returns true when the change was absorbed without a rebuild. */
  #patch(source: TextureSource, before: Source, after: Source): boolean {
    if (before.kind !== after.kind) return false;
    if (after.kind === 'color' && source instanceof ColorSource) {
      source.setColor(after.rgb);
      return true;
    }
    if (after.kind === 'video' && before.kind === 'video' && source instanceof VideoTextureSource) {
      if (before.path !== after.path) return false;
      source.setPlayback({ loop: after.loop, muted: after.muted, rate: after.rate });
      return true;
    }
    if (after.kind === 'text' && source instanceof TextSource) {
      // Typing is a stream of descriptors: rebuilding on each one would throw
      // the texture away and blink on the wall between keystrokes.
      source.setText(after);
      return true;
    }
    // Anything else: rebuild unless nothing meaningful changed.
    return JSON.stringify(before) === JSON.stringify(after);
  }

  get(id: string | null): TextureSource | null {
    return id ? this.#entries.get(id)?.source ?? null : null;
  }

  /** True when any live source animates — the render loop uses this to decide
   *  whether it may go back to sleep. */
  get hasAnimated(): boolean {
    for (const { source } of this.#entries.values()) {
      if (source.animated && source.status === 'ready') return true;
    }
    return false;
  }

  /**
   * Sobe o que estiver pendente e diz se subiu algo.
   *
   * É esse retorno que acorda o loop quando uma imagem termina de carregar
   * depois que tudo já estava parado: ela não é animada, ninguém mutou o
   * projeto, e sem este sinal a textura subiria para uma GPU que ninguém mandou
   * desenhar — ficando invisível até o próximo clique.
   */
  update(gl: WebGL2RenderingContext): boolean {
    let uploaded = false;
    for (const { source } of this.#entries.values()) {
      const before = source.isDirty;
      source.update(gl);
      if (before) uploaded = true;
    }
    return uploaded;
  }

  /** Called on the first user gesture — browsers block autoplay until then. */
  unlock(): void {
    for (const { source } of this.#entries.values()) {
      if (source instanceof VideoTextureSource) source.unlock();
    }
  }

  /**
   * Drops this context's textures and keeps the content alive.
   *
   * Closing the output window must not stop the clip the editor is still
   * showing — and, more to the point, must not make a screen capture ask for
   * permission all over again.
   */
  releaseContext(gl: WebGL2RenderingContext): void {
    for (const { source } of this.#entries.values()) source.release(gl);
  }

  disposeAll(gl: WebGL2RenderingContext): void {
    for (const { source } of this.#entries.values()) source.dispose(gl);
    this.#entries.clear();
  }
}
