import type { CanvasModule, Store } from '../../engine/index.ts';
import { parseProject } from '../../engine/model/project.ts';
import { createSaver, safeName, type Saver } from './saver.ts';
import { forgetFolder, recallFolder, rememberFolder } from './handle-store.ts';

/**
 * A project is a folder, not a file: `project.json` with relative paths and the
 * media sitting next to it. That is what survives being copied to a USB stick
 * and carried to the venue.
 *
 * Where the File System Access API is missing we degrade loudly: media stays in
 * memory as blob URLs for the session and the project JSON is kept in
 * localStorage, so nothing is lost on a refresh but the media links do not
 * survive a restart. The user is told, never left to discover it on site.
 */

type DirHandle = FileSystemDirectoryHandle;

// The prefix is a storage namespace, not the product name. The tool is called
// ProjMap now and this key deliberately did not follow: renaming it throws away
// the saved project of everyone who upgrades, on their first open. Changing it
// would have to ship with a migration that reads the old key first.
const LOCAL_KEY = 'map-engine:project';

/** Falha que o usuário precisa entender. O texto é escolhido por quem tem o
 *  catálogo — este módulo só diz o que aconteceu. */
export class FolderError extends Error {
  // Campo declarado e atribuído à mão, e não uma parameter property: o projeto
  // roda os testes com o type-stripping nativo do node, que não suporta a
  // forma curta. Um módulo que não pode ser importado por um teste é um módulo
  // sem teste.
  readonly code: 'unsupported';
  constructor(code: 'unsupported') { super(code); this.code = code; }
}

export const hasFileSystemAccess = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

let dir: DirHandle | null = null;
const urlCache = new Map<string, string>();
/** Session-only media for the no-folder fallback, keyed by the same relative path. */
const memoryFiles = new Map<string, File>();
let importQueue: Promise<void> = Promise.resolve();

export function folderName(): string { return dir?.name ?? ''; }

export async function openFolder(): Promise<string | null> {
  if (!hasFileSystemAccess) throw new FolderError('unsupported');
  const picker = (globalThis as unknown as {
    showDirectoryPicker(opts: { mode: 'readwrite' }): Promise<DirHandle>;
  }).showDirectoryPicker;
  const handle = await picker({ mode: 'readwrite' });
  let json: string | null;
  try { json = await readProject(handle); } catch (error) {
    if ((error as DOMException | null)?.name !== 'NotFoundError') throw error;
    json = null;
  }
  activateFolder(handle);
  // Guardar o handle é o que faz a próxima sessão não começar pelo diálogo do
  // sistema. Falhar aqui não pode derrubar a abertura que já deu certo.
  void rememberFolder(handle).catch(() => {});
  return json;
}

async function readProject(handle: DirHandle): Promise<string> {
  const file = await (await handle.getFileHandle('project.json')).getFile();
  const json = await file.text();
  parseProject(JSON.parse(json));
  return json;
}

function activateFolder(handle: DirHandle): void {
  // A pending save belongs to the old destination. In-flight saves retain
  // their own handle; later saves get a new saver bound to this folder.
  saver?.cancel();
  saver = null;
  saverStore = null;
  invalidateUrls();
  memoryFiles.clear();
  dir = handle;
}

/**
 * O que sobrou da sessão anterior:
 *
 * - `null` — não há handle guardado, ou o navegador não guarda nada.
 * - `granted` — a pasta foi readotada e o projeto já vem lido.
 * - `prompt` — o handle existe mas falta permissão, que só pode ser pedida de
 *   dentro de um gesto do usuário. A interface mostra um botão com este nome.
 */
export type Adopted = { state: 'granted'; name: string; json: string | null };
export type Restored = Adopted | { state: 'prompt'; name: string };

export type Permissioned = FileSystemDirectoryHandle & {
  queryPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
};

/** Adota o handle e lê o `project.json`, ou desiste dele se a pasta sumiu. */
async function adopt(handle: FileSystemDirectoryHandle): Promise<Adopted | null> {
  let json: string;
  try {
    json = await readProject(handle);
  } catch (e) {
    // Pasta vazia é projeto novo. Pasta que não existe mais é outra coisa: o
    // handle está morto e insistir nele só produziria erro a cada salvamento.
    if ((e as DOMException | null)?.name === 'NotFoundError') {
      await forgetFolder();
      return null;
    }
    throw e;
  }
  activateFolder(handle);
  return { state: 'granted', name: handle.name, json };
}

/**
 * Tenta voltar para a pasta da sessão anterior. Chamada uma vez, na partida,
 * com o projeto ainda vazio — nunca depois, para não haver como um handle
 * recuperado passar por cima de trabalho já em memória.
 */
export async function restoreFolder(): Promise<Restored | null> {
  if (!hasFileSystemAccess) return null;
  const handle = (await recallFolder()) as Permissioned | null;
  if (!handle) return null;
  return await restoreFrom(handle);
}

/**
 * A decisão, separada do encanamento: dado um handle, o que fazer com ele.
 *
 * Está exportada porque o seletor de pasta abre um diálogo do sistema
 * operacional, que nenhum teste automatizado consegue operar — a única forma de
 * cobrir permissão negada, permissão pendente e handle morto é entregar o
 * handle por parâmetro. Mesmo motivo pelo qual `saver.ts` recebe um escritor.
 */
export async function restoreFrom(handle: Permissioned): Promise<Restored | null> {
  let permission: PermissionState;
  try {
    permission = await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    await forgetFolder();
    return null;
  }

  if (permission === 'granted') return await adopt(handle);
  // `denied` é uma resposta, não um erro: o usuário disse não a esta pasta e
  // continuar oferecendo um botão para ela seria insistência.
  if (permission === 'denied') { await forgetFolder(); return null; }
  return { state: 'prompt', name: handle.name };
}

/**
 * Pede a permissão que faltava. Precisa ser chamada de dentro de um clique: o
 * navegador rejeita o pedido fora de um gesto do usuário, de propósito.
 */
export async function grantFolder(): Promise<Adopted | null> {
  const handle = (await recallFolder()) as Permissioned | null;
  if (!handle) return null;
  let permission: PermissionState;
  try {
    permission = await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    return null;
  }
  if (permission !== 'granted') {
    if (permission === 'denied') await forgetFolder();
    return null;
  }
  return await adopt(handle);
}

/** Relative path -> a URL the browser can fetch. Throws when the file is gone,
 *  which is what makes the surface show the missing-media pattern. */
export async function resolveUrl(path: string): Promise<string> {
  // Um caminho que já é URL não é um caminho relativo à pasta: `data:`, `blob:`
  // e `http(s):` passam direto, senão o resolvedor procuraria um arquivo com
  // aquele nome e a superfície acenderia o padrão de mídia faltando.
  if (/^(data|blob|https?):/.test(path)) return path;

  const cached = urlCache.get(path);
  if (cached) return cached;

  const mem = dir ? undefined : memoryFiles.get(path);
  if (mem) {
    const url = URL.createObjectURL(mem);
    urlCache.set(path, url);
    return url;
  }
  if (!dir) throw new Error(`no project folder: ${path}`);

  // Paths are relative and may contain folders: walk the segments.
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop()!;
  const target = dir;
  let d = target;
  for (const part of parts) d = await d.getDirectoryHandle(part);
  const file = await (await d.getFileHandle(name)).getFile();
  if (dir !== target) throw new Error('Project folder changed while reading media');
  const url = URL.createObjectURL(file);
  urlCache.set(path, url);
  return url;
}

/** Copies a dropped file into the project folder and returns its relative path. */
export function importFile(file: File): Promise<string> {
  const target = dir;
  // Serialize name allocation with writes, including simultaneous drops.
  const imported = importQueue.then(() => copyFile(file, target));
  importQueue = imported.then(() => {}, () => {});
  return imported;
}

async function copyFile(file: File, target: DirHandle | null): Promise<string> {
  const name = safeName(file.name);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  const exists = async (path: string): Promise<boolean> => {
    if (!target) return memoryFiles.has(path);
    try { await target.getFileHandle(path); return true; } catch (error) {
      const code = (error as DOMException | null)?.name;
      if (code === 'NotFoundError') return false;
      if (code === 'TypeMismatchError') return true;
      throw error;
    }
  };
  let path = name;
  let suffix = 2;
  // project.json always belongs to the saver.
  while (await exists(path) || path === 'project.json') {
    path = `${stem}_${suffix++}${extension}`;
  }
  if (target) {
    const handle = await target.getFileHandle(path, { create: true });
    const writable = await handle.createWritable();
    await writable.write(file);
    await writable.close();
  } else {
    memoryFiles.set(path, file);
  }
  urlCache.delete(path);
  return path;
}

/** Loads a user canvas module from the folder. */
export async function loadModule(moduleId: string): Promise<CanvasModule> {
  const url = await resolveUrl(moduleId.endsWith('.js') ? moduleId : `${moduleId}.js`);
  const mod = (await import(/* @vite-ignore */ url)) as Partial<CanvasModule>;
  if (typeof mod.draw !== 'function') throw new Error('module has no draw(ctx, t)');
  return mod as CanvasModule;
}

/**
 * Autosave. A lógica de espera e de escrita concorrente mora em `saver.ts`,
 * testada com um escritor falso; aqui fica só a parte que precisa de navegador.
 *
 * Perder meia hora de alinhamento por causa de um crash é inaceitável numa
 * ferramenta de montagem — por isso o salvamento não depende de ninguém lembrar
 * de apertar nada.
 */
const AUTOSAVE_MS = 400;

let saver: Saver | null = null;
let saverStore: Store | null = null;

/** Rótulo usado quando não há pasta. Injetado porque a palavra é do catálogo. */
let memoryLabel = 'browser memory';
export function setMemoryLabel(label: string): void { memoryLabel = label; }

function saverFor(
  store: Store,
  onSaved?: (where: string) => void,
  onError?: (message: string) => void,
): Saver {
  // Um saver por store: trocar de projeto não pode arrastar uma escrita pendente
  // do projeto anterior.
  if (saver && saverStore === store) return saver;
  saver?.cancel();
  saverStore = store;
  const target = dir;
  saver = createSaver({
    delay: AUTOSAVE_MS,
    read: () => store.toJSON(),
    write: async (contents) => {
      if (target) {
        const handle = await target.getFileHandle('project.json', { create: true });
        const writable = await handle.createWritable();
        await writable.write(contents);
        await writable.close();
      } else {
        localStorage.setItem(LOCAL_KEY, contents);
      }
    },
    onSaved: () => { if (dir === target) onSaved?.(target ? target.name : memoryLabel); },
    onError: (error) => onError?.(`Não consegui salvar: ${String((error as Error).message ?? error)}`),
  });
  return saver;
}

export function scheduleSave(
  store: Store,
  onSaved?: (where: string) => void,
  onError?: (message: string) => void,
): void {
  saverFor(store, onSaved, onError).schedule();
}

export async function save(
  store: Store,
  onSaved?: (where: string) => void,
  onError?: (message: string) => void,
): Promise<void> {
  await saverFor(store, onSaved, onError).flush();
}

/** Project JSON kept in localStorage by the fallback path, if any. */
export function localProject(): string | null {
  // Private mode can refuse storage entirely; "no saved project" is the truth.
  try { return localStorage.getItem(LOCAL_KEY); } catch { return null; }
}

/** Manual export for the no-folder case: a plain download of project.json. */
export function downloadProject(store: Store): void {
  const blob = new Blob([store.toJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Media the engine may still be holding a URL for, dropped on folder change. */
export function invalidateUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}
