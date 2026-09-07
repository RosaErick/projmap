import { ContextTextures, uploadTexture, type SourceContext, type SourceError, type SourceErrorCode, type TextureSource } from './types.ts';

/** `requestVideoFrameCallback` is stable in Chromium but not in every lib.dom. */
type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?(cb: (now: number, meta: unknown) => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

/**
 * Anything that paints into a `<video>`: a file, a screen capture, a webcam.
 *
 * The upload is driven by `requestVideoFrameCallback`, not by the render loop.
 * A 25fps clip on a 60Hz monitor then uploads 25 times a second instead of 60,
 * which is two thirds of the texture traffic gone for free. Where the callback
 * is missing we fall back to marking dirty every frame.
 */
export class VideoTextureSource implements TextureSource {
  size: [number, number] = [0, 0];
  status: 'loading' | 'ready' | 'error' = 'loading';
  error?: SourceError;
  readonly animated = true;
  protected video: VideoWithRVFC;
  protected textures = new ContextTextures();
  /** False on browsers without requestVideoFrameCallback — see #scheduleFrame. */
  #hasRvfc = false;
  #rvfcHandle: number | null = null;
  #objectUrl: string | null = null;
  #disposed = false;

  constructor() {
    const v = document.createElement('video') as VideoWithRVFC;
    v.muted = true;          // autoplay is blocked with sound, always
    v.playsInline = true;
    v.loop = true;
    v.crossOrigin = 'anonymous';
    this.video = v;
    const measure = (): void => {
      if (this.#disposed) return;
      // Firefox and Safari can report 0x0 for a live stream until the first
      // frame lands, and a webcam may renegotiate its resolution mid-session.
      // The track's own settings are the reliable answer when they do.
      let [w, h] = [v.videoWidth, v.videoHeight];
      if ((!w || !h) && v.srcObject instanceof MediaStream) {
        const settings = v.srcObject.getVideoTracks()[0]?.getSettings();
        w = settings?.width ?? w;
        h = settings?.height ?? h;
      }
      if (w && h) {
        this.size = [w, h];
        this.status = 'ready';
        this.textures.invalidate();
      }
    };
    v.addEventListener('loadedmetadata', measure);
    v.addEventListener('resize', measure);
    v.addEventListener('playing', measure);
    v.addEventListener('error', () => {
      if (this.#disposed) return;
      this.status = 'error';
      this.error = { code: 'video-failed' };
    });
    this.#scheduleFrame();
  }

  get isDirty(): boolean { return this.textures.anyStale; }

  /**
   * Drives the upload from the video's own frame rate, not the monitor's: a
   * 25fps clip on a 60Hz screen uploads 25 times a second instead of 60.
   *
   * Where `requestVideoFrameCallback` is missing — Firefox and older Safari —
   * there is no callback to re-arm, so the source must be treated as stale on
   * every render instead. Marking it dirty once here is what used to freeze
   * every video and webcam on those browsers after the first frame.
   */
  #scheduleFrame(): void {
    const v = this.video;
    if (typeof v.requestVideoFrameCallback !== 'function') return;
    this.#hasRvfc = true;
    this.#rvfcHandle = v.requestVideoFrameCallback(() => {
      if (this.#disposed) return;
      this.textures.invalidate();
      this.#scheduleFrame();
    });
  }

  protected setSrcObject(stream: MediaStream): void {
    // Permission can resolve after the source was removed or replaced.
    if (this.#disposed) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.video.srcObject = stream;
    // "Stop sharing" ends the track. Without this the surface would freeze on
    // its last frame and keep lying to whoever is looking at the wall.
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        this.status = 'error';
        this.error = { code: 'capture-ended' };
      });
    }
    void this.video.play().catch(() => { /* unlocked by the first user gesture */ });
  }

  protected setSrcUrl(url: string, objectUrl = false): void {
    if (this.#disposed) {
      if (objectUrl) URL.revokeObjectURL(url);
      return;
    }
    if (objectUrl) this.#objectUrl = url;
    this.video.src = url;
    void this.video.play().catch(() => { /* unlocked by the first user gesture */ });
  }

  /** Called after the first user gesture, when browsers allow playback. */
  unlock(): void {
    if (this.video.paused) void this.video.play().catch(() => {});
  }

  setPlayback(opts: { loop?: boolean; muted?: boolean; rate?: number }): void {
    if (opts.loop !== undefined) this.video.loop = opts.loop;
    if (opts.muted !== undefined) this.video.muted = opts.muted;
    if (opts.rate !== undefined && opts.rate > 0) this.video.playbackRate = opts.rate;
  }

  getTexture(gl: WebGL2RenderingContext): WebGLTexture | null {
    return this.status === 'ready' ? this.textures.texture(gl) : null;
  }

  update(gl: WebGL2RenderingContext): void {
    if (this.status !== 'ready' || this.video.readyState < 2) return;
    // Without rVFC nobody tells us a frame arrived, so every render is a
    // candidate; with it, only the contexts behind the current frame re-upload.
    if (!this.#hasRvfc && !this.video.paused) this.textures.invalidate();
    if (!this.textures.isStale(gl)) return;
    uploadTexture(gl, this.textures.texture(gl), this.video);
    this.textures.markUploaded(gl);
  }

  release(gl: WebGL2RenderingContext): void { this.textures.release(gl); }

  dispose(_gl: WebGL2RenderingContext): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#rvfcHandle !== null) this.video.cancelVideoFrameCallback?.(this.#rvfcHandle);
    const stream = this.video.srcObject;
    // Stopping the tracks is what turns the webcam light off. Skipping it leaves
    // a camera live on a machine nobody is sitting at.
    if (stream instanceof MediaStream) for (const t of stream.getTracks()) t.stop();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.video.load();
    if (this.#objectUrl) URL.revokeObjectURL(this.#objectUrl);
    this.textures.disposeAll();
  }
}

/** A video file from the project folder. WebM with alpha works and is how
 *  cut-out content for projection is usually authored. */
export class FileVideoSource extends VideoTextureSource {
  constructor(path: string, ctx: SourceContext, opts: { loop: boolean; muted: boolean; rate: number }) {
    super();
    this.setPlayback(opts);
    void ctx.resolveUrl(path).then(
      (url) => this.setSrcUrl(url),
      () => {
        this.status = 'error';
        this.error = { code: 'video-failed', detail: path };
      },
    );
  }
}

/** Screen or window capture. This is Spout/Syphon for the browser: any other
 *  application running on the machine becomes a mappable texture. */
export class CaptureSource extends VideoTextureSource {
  constructor() {
    super();
    const md = navigator.mediaDevices;
    if (!md?.getDisplayMedia) {
      this.status = 'error';
      this.error = { code: 'capture-unavailable' };
      return;
    }
    void md.getDisplayMedia({ video: true, audio: false }).then(
      (stream) => this.setSrcObject(stream),
      () => {
        this.status = 'error';
        this.error = { code: 'capture-denied' };
      },
    );
  }
}

/** Live camera. */
export class CameraSource extends VideoTextureSource {
  constructor(deviceId?: string) {
    super();
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      this.status = 'error';
      this.error = { code: 'camera-unavailable' };
      return;
    }
    // `exact` fails outright when the camera was unplugged since the project was
    // saved; `ideal` falls back to whatever is there, which is what someone
    // reopening a project on another machine wants.
    const video: boolean | MediaTrackConstraints = deviceId ? { deviceId: { ideal: deviceId } } : true;
    void md.getUserMedia({ video, audio: false }).then(
      (stream) => this.setSrcObject(stream),
      (e: unknown) => {
        this.status = 'error';
        this.error = { code: cameraErrorCode(e) };
      },
    );
  }
}

/** Maps a getUserMedia rejection onto a code the host can explain. */
function cameraErrorCode(e: unknown): SourceErrorCode {
  switch ((e as { name?: string } | null)?.name ?? '') {
    case 'NotAllowedError': return 'camera-denied';
    case 'NotFoundError': return 'camera-not-found';
    case 'NotReadableError': return 'camera-in-use';
    case 'OverconstrainedError': return 'camera-gone';
    default: return 'camera-failed';
  }
}

/**
 * Cameras available for selection.
 *
 * Labels only exist after permission has been granted at least once; before
 * that browsers return an empty string. The empty label is passed through as-is
 * so the host can put its own wording there — naming a device is interface copy,
 * and the engine does not write interface copy.
 */
export async function listCameras(): Promise<{ deviceId: string; label: string }[]> {
  const md = navigator.mediaDevices;
  if (!md?.enumerateDevices) return [];
  try {
    const devices = await md.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'videoinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    // enumerateDevices rejects when the page has no permission at all. An empty
    // list is the honest answer: there is nothing to offer the user yet.
    return [];
  }
}
