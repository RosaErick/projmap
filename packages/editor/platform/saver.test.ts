import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaver, safeName } from './saver.ts';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('AC-42: writes once after the quiet period, with the newest content', async () => {
  const written: string[] = [];
  let content = 'a';
  const saver = createSaver({
    read: () => content,
    write: async (data) => { written.push(data); },
    delay: 5,
  });

  saver.schedule();
  content = 'b';
  saver.schedule();
  content = 'c';
  saver.schedule();

  await tick(30);
  assert.deepEqual(written, ['c'], 'one write, with the state at write time');
});

test('AC-42: a write in flight queues exactly one more, never drops the newer state', async () => {
  const written: string[] = [];
  let content = 'first';
  // Deferred the first write blocks on, so the next ones land mid-flight.
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });

  const saver = createSaver({
    read: () => content,
    write: async (data) => {
      written.push(data);
      if (written.length === 1) await held;
    },
    delay: 0,
  });

  // Not awaited: this flush stays open inside `write` until `release` is called.
  void saver.flush();
  await tick();
  assert.deepEqual(written, ['first'], 'the first write started');

  content = 'second';
  void saver.flush();
  content = 'third';
  void saver.flush();
  await tick(5);
  assert.deepEqual(written, ['first'], 'nothing else ran while the first was open');

  release();
  await tick(10);

  // Exactly one catch-up write, carrying the newest content — not two.
  assert.deepEqual(written, ['first', 'third']);
});

test('AC-42: a failed write reports and does not wedge the saver', async () => {
  const errors: unknown[] = [];
  const written: string[] = [];
  let fail = true;

  const saver = createSaver({
    read: () => 'data',
    write: async (data) => {
      if (fail) throw new Error('disk full');
      written.push(data);
    },
    onError: (e) => errors.push(e),
    delay: 0,
  });

  await saver.flush();
  assert.equal(errors.length, 1, 'the failure was reported');
  assert.deepEqual(written, [], 'nothing was written');

  fail = false;
  await saver.flush();
  assert.deepEqual(written, ['data'], 'the saver still works after a failure');
});

test('AC-42: cancel drops a pending write', async () => {
  const written: string[] = [];
  const saver = createSaver({ read: () => 'x', write: async (d) => { written.push(d); }, delay: 5 });
  saver.schedule();
  saver.cancel();
  await tick(20);
  assert.deepEqual(written, []);
});

test('AC-43: a dropped file name never escapes the project folder', () => {
  assert.equal(safeName('clip.mp4'), 'clip.mp4');
  assert.equal(safeName('a b/c.mp4'), 'c.mp4');
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('.hidden'), 'hidden');
  assert.equal(safeName('///'), 'file');
  assert.equal(safeName('C:\\\\Users\\\\me\\\\clip.mov'), 'clip.mov');
  assert.equal(safeName('vídeo final (2).mov'), 'v_deo_final_2_.mov');
});

test('AC-98: cancelling an in-flight saver drops its queued follow-up', async () => {
  const written: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const saver = createSaver({
    read: () => 'old project',
    write: async (json) => { written.push(json); await held; },
  });
  const first = saver.flush();
  await saver.flush();
  saver.cancel();
  release();
  await first;
  assert.deepEqual(written, ['old project']);
});
