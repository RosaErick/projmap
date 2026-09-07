import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../model/store.ts';
import { SourcePool } from './index.ts';

test('AC-100: relinking the same path retries failed media without persisting reload state', async () => {
  const store = new Store();
  store.addSource({ id: 'image', name: '', kind: 'image', path: 'photo.png' });
  const saved = store.toJSON();
  let requests = 0;
  const pool = new SourcePool({ resolveUrl: async () => { requests++; throw new Error('Missing media'); } });
  const gl = {} as WebGL2RenderingContext;
  const sync = (): void => pool.sync(gl, store.project.sources, store.view.sourceRevisions);
  sync();
  await Promise.resolve();
  const failed = pool.get('image');
  assert.equal(failed?.status, 'error');
  store.relinkSource('image', 'photo.png');
  sync();
  await Promise.resolve();
  assert.notEqual(pool.get('image'), failed);
  assert.equal(requests, 2);
  assert.equal(store.toJSON(), saved);
  // A second engine sharing this pool must not issue a third request.
  sync();
  assert.equal(requests, 2);
  pool.disposeAll(gl);
});
