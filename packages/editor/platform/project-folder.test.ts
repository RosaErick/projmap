import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importFile, resolveUrl, restoreFrom, save, scheduleSave, type Permissioned } from './project-folder.ts';
import { Store } from '../../engine/model/store.ts';

/** Um handle de mentira: o de verdade só sai de um diálogo do sistema, que
 *  nenhum teste consegue operar. */
function fakeHandle(opts: {
  permission: PermissionState;
  json?: string;
  missing?: boolean;
  onRequest?: () => void;
  files?: Map<string, string>;
  onWrite?: (json: string) => void;
  readError?: string;
}): Permissioned {
  return {
    name: 'palco',
    async queryPermission() { return opts.permission; },
    async requestPermission() { opts.onRequest?.(); return opts.permission; },
    async getFileHandle(path: string, options?: { create?: boolean }) {
      if (opts.readError) throw new DOMException('Read failed', opts.readError);
      if (opts.files && path !== 'project.json') {
        if (!opts.files.has(path) && !options?.create) throw new DOMException('Missing file', 'NotFoundError');
        return {
          async getFile() { return new File([opts.files!.get(path) ?? ''], path); },
          async createWritable() {
            return {
              async write(file: File) { opts.files!.set(path, await file.text()); },
              async close() {},
            };
          },
        };
      }
      if (opts.missing) {
        const e = new Error('no such file');
        e.name = 'NotFoundError';
        throw e;
      }
      if (opts.json === undefined) {
        const e = new Error('empty folder');
        e.name = 'NotFoundError';
        throw e;
      }
      return {
        async getFile() { return { async text() { return opts.json; } }; },
        async createWritable() {
          return {
            async write(json: string) { opts.onWrite?.(json); },
            async close() {},
          };
        },
      };
    },
  } as unknown as Permissioned;
}

test('AC-97: imports with matching names preserve both files in memory and on disk', async () => {
  const first = new File(['first'], 'same.png');
  const second = new File(['second'], 'same.png');
  const paths = await Promise.all([importFile(first), importFile(second)]);
  assert.notEqual(paths[0], paths[1]);
  assert.deepEqual(await Promise.all(paths.map(async (path) =>
    (await fetch(await resolveUrl(path))).text())), ['first', 'second']);

  const files = new Map([['same.png', 'original']]);
  await restoreFrom(fakeHandle({ permission: 'granted', json: '{"version":1}', files }));
  const imported = await Promise.all([importFile(first), importFile(second)]);
  assert.notEqual(imported[0], imported[1]);
  assert.equal(files.get('same.png'), 'original');
  assert.deepEqual(imported.map((path) => files.get(path)), ['first', 'second']);
});

test('AC-56: a pasta permitida volta com o projeto já lido', async () => {
  const restored = await restoreFrom(fakeHandle({ permission: 'granted', json: '{"version":1}' }));
  assert.equal(restored?.state, 'granted');
  assert.equal(restored?.name, 'palco');
  assert.equal(restored?.state === 'granted' ? restored.json : null, '{"version":1}');
});

test('AC-57: permissão pendente não é escalada sozinha', async () => {
  let asked = false;
  const restored = await restoreFrom(fakeHandle({ permission: 'prompt', onRequest: () => { asked = true; } }));
  assert.equal(restored?.state, 'prompt', 'devolve o nome para a interface oferecer o clique');
  assert.equal(restored?.name, 'palco');
  assert.equal(asked, false, 'pedir permissão fora de um gesto do usuário é rejeitado pelo navegador');
});

test('AC-57: permissão negada não vira botão para insistir', async () => {
  assert.equal(await restoreFrom(fakeHandle({ permission: 'denied' })), null);
});

test('AC-58: handle cuja pasta sumiu é esquecido em vez de adotado', async () => {
  assert.equal(await restoreFrom(fakeHandle({ permission: 'granted', missing: true })), null);
});

test('AC-98: failed folder validation preserves the previous save destination', async () => {
  const written: string[] = [];
  const store = new Store();
  store.addSurface();
  await restoreFrom(fakeHandle({ permission: 'granted', json: '{"version":1}', onWrite: (json) => written.push(json) }));
  for (const invalid of [{ json: '{broken' }, { json: '{"version":99}' }, { readError: 'NotReadableError' }]) {
    await assert.rejects(restoreFrom(fakeHandle({ permission: 'granted', ...invalid })));
    await save(store);
  }
  assert.deepEqual(written, Array<string>(3).fill(store.toJSON()));
});

test('AC-98: switching folders cancels a pending save before adopting the new destination', async () => {
  const written: string[] = [];
  const store = new Store();
  await restoreFrom(fakeHandle({ permission: 'granted', json: '{"version":1}' }));
  scheduleSave(store);
  await restoreFrom(fakeHandle({ permission: 'granted', json: '{"version":1}', onWrite: (json) => written.push(json) }));
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(written, []);
  await save(store);
  assert.deepEqual(written, [store.toJSON()]);
});
