import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { CameraSource, CaptureSource, FileVideoSource } from './video.ts';

class FakeTrack extends EventTarget {
  stops = 0;
  stop(): void { this.stops++; }
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks(): FakeTrack[] { return this.tracks; }
}

class FakeVideo extends EventTarget {
  srcObject: FakeStream | null = null;
  src = '';
  plays = 0;
  async play(): Promise<void> { this.plays++; }
  removeAttribute(): void { this.src = ''; }
  load(): void {}
}

function setGlobal(t: TestContext, name: string, value: unknown): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  });
}

for (const kind of ['camera', 'capture'] as const) {
  for (const late of [true, false]) {
    test(`AC-106: ${kind} stops every track when permission resolves ${late ? 'after' : 'before'} disposal`, async (t) => {
      const video = new FakeVideo();
      let grant = (_stream: FakeStream): void => {};
      const permission = new Promise<FakeStream>((resolve) => { grant = resolve; });
      setGlobal(t, 'document', { createElement: () => video });
      setGlobal(t, 'MediaStream', FakeStream);
      setGlobal(t, 'navigator', { mediaDevices: {
        getUserMedia: () => permission,
        getDisplayMedia: () => permission,
      } });
      const source = kind === 'camera' ? new CameraSource() : new CaptureSource();
      const gl = {} as WebGL2RenderingContext;
      if (late) source.dispose(gl);
      const stream = new FakeStream();
      grant(stream);
      await permission;
      if (!late) {
        assert.equal(video.srcObject, stream);
        assert.equal(video.plays, 1);
        assert.deepEqual(stream.tracks.map((track) => track.stops), [0, 0]);
      }
      source.dispose(gl);
      assert.equal(video.srcObject, null);
      assert.deepEqual(stream.tracks.map((track) => track.stops), [1, 1]);
      if (late) assert.equal(video.plays, 0, 'discarded sources never start playback');
    });
  }
}

test('AC-106: a video URL resolved after disposal never restarts playback', async (t) => {
  const video = new FakeVideo();
  setGlobal(t, 'document', { createElement: () => video });
  setGlobal(t, 'MediaStream', FakeStream);
  let resolve = (_url: string): void => {};
  const pending = new Promise<string>((done) => { resolve = done; });
  const source = new FileVideoSource('clip.webm', { resolveUrl: () => pending }, { loop: true, muted: true, rate: 1 });
  source.dispose({} as WebGL2RenderingContext);
  resolve('blob:late-video');
  await pending;
  assert.equal(video.src, '');
  assert.equal(video.plays, 0);
});
