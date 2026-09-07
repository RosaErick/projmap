import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, currentScene, visibleSurfaces, patternFor, presentationOf } from './store.ts';
import { anchorId, emptyProject } from './project.ts';
import { surfaceOrder } from './surface-math.ts';
import { isIdentity, evaluateWarp } from './warp.ts';

test('AC-7: undo restores the previous state and redo reapplies it', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  const x0 = store.project.surfaces[0]!.frame[0]!.x;
  store.setCorner(s.id, 0, { x: x0 + 50, y: 0 });
  store.endGesture();
  assert.equal(store.project.surfaces[0]!.frame[0]!.x, x0 + 50);
  store.undo();
  assert.equal(store.project.surfaces[0]!.frame[0]!.x, x0);
  store.redo();
  assert.equal(store.project.surfaces[0]!.frame[0]!.x, x0 + 50);
});

test('AC-8: a drag gesture collapses into one history entry', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  const before = store.project.surfaces[0]!.frame[0]!.x;
  for (let i = 1; i <= 20; i++) store.setCorner(s.id, 0, { x: before + i, y: 0 });
  store.endGesture();
  store.undo();
  assert.equal(store.project.surfaces[0]!.frame[0]!.x, before);
});

test('AC-9: a locked surface rejects every geometry edit', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.toggleLock(s.id);
  const before = structuredClone(store.project.surfaces[0]!.frame);
  store.setCorner(s.id, 0, { x: 999, y: 999 });
  store.moveSurface(s.id, 100, 100);
  store.nudgeCorner(s.id, 1, 1, 1);
  assert.deepEqual(store.project.surfaces[0]!.frame, before);
});

test('AC-10: subscribe fires immediately, on change, and stops after unsubscribe', () => {
  const store = new Store(emptyProject());
  let calls = 0;
  const off = store.subscribe(() => { calls++; });
  assert.equal(calls, 1);
  store.addSurface();
  assert.ok(calls > 1);
  const atUnsub = calls;
  off();
  store.addSurface();
  assert.equal(calls, atUnsub);
});

test('AC-11: solo overrides visibility and drawing follows z order', () => {
  const store = new Store(emptyProject());
  const a = store.addSurface();
  const b = store.addSurface();
  store.reorder(a.id, 5);
  store.reorder(b.id, 1);
  assert.deepEqual(visibleSurfaces(store.state).map((s) => s.id), [b.id, a.id]);
  store.toggleVisible(b.id);
  assert.deepEqual(visibleSurfaces(store.state).map((s) => s.id), [a.id]);
  store.toggleSolo(b.id);
  assert.deepEqual(visibleSurfaces(store.state).map((s) => s.id), [b.id]);
});

test('AC-12: removing a source clears the surfaces that referenced it', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.addSource({ id: 'c1', name: 'branco', kind: 'color', rgb: [255, 255, 255] });
  store.setSurfaceSource(s.id, 'c1');
  store.removeSource('c1');
  assert.equal(store.project.surfaces[0]!.sourceId, null);
});

test('AC-13: a project round trips through JSON, dropping dangling references', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.addSource({ id: 'c1', name: 'branco', kind: 'color', rgb: [255, 255, 255] });
  store.setSurfaceSource(s.id, 'c1');
  const json = store.toJSON();
  const store2 = new Store(emptyProject());
  store2.load(json);
  assert.deepEqual(store2.project, store.project);

  const broken = JSON.parse(json);
  broken.sources = [];
  store2.load(broken);
  assert.equal(store2.project.surfaces[0]!.sourceId, null);
});

test('AC-9: a locked surface rejects geometry through the generic patch too', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.toggleLock(s.id);
  const frame = structuredClone(store.project.surfaces[0]!.frame);
  // The external-control extension point calls these same methods.
  store.patchSurface(s.id, { frame: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], name: 'novo' });
  assert.deepEqual(store.project.surfaces[0]!.frame, frame);
  assert.equal(store.project.surfaces[0]!.name, 'novo');
  // Unlocking must still be possible, or the lock is a trap.
  store.toggleLock(s.id);
  assert.equal(store.project.surfaces[0]!.locked, false);
});

test('AC-11: the projected surface number follows the editor list order', () => {
  const store = new Store(emptyProject());
  const a = store.addSurface();
  const b = store.addSurface();
  store.reorder(a.id, 1);
  store.reorder(b.id, 9);
  const surfaces = store.project.surfaces;
  const order = surfaceOrder(store.project);
  const top = surfaces.find((s) => s.id === b.id)!;
  const bottom = surfaces.find((s) => s.id === a.id)!;
  assert.equal(order.get(top), 1);
  assert.equal(order.get(bottom), 2);
});

test('AC-32: a surface without an override follows the global test pattern', () => {
  const store = new Store(emptyProject());
  const a = store.addSurface();
  const b = store.addSurface();
  store.setTestPattern('grid');
  assert.equal(patternFor(store.state, a.id), 'grid');
  assert.equal(patternFor(store.state, b.id), 'grid');
});

test('AC-32: a per-surface pattern wins over the global one, in both directions', () => {
  const store = new Store(emptyProject());
  const a = store.addSurface();
  const b = store.addSurface();

  store.setTestPattern('grid');
  store.setSurfacePattern(a.id, 'number');
  assert.equal(patternFor(store.state, a.id), 'number');
  assert.equal(patternFor(store.state, b.id), 'grid');

  // An explicit 'none' clears the pattern on one surface while the rest keep it.
  store.setSurfacePattern(b.id, 'none');
  assert.equal(patternFor(store.state, b.id), 'none');

  // null hands control back to the global pattern.
  store.setSurfacePattern(a.id, null);
  assert.equal(patternFor(store.state, a.id), 'grid');
});

test('AC-32: removing a surface drops its pattern override and its solo', () => {
  const store = new Store(emptyProject());
  const a = store.addSurface();
  store.setSurfacePattern(a.id, 'bars');
  store.toggleSolo(a.id);
  store.removeSurface(a.id);
  assert.deepEqual(store.view.surfacePatterns, {});
  assert.equal(store.view.soloId, null);
});

test('AC-37: crop is clamped to a window that samples something', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.setCrop(s.id, { x: 0.25, w: 0.5 });
  assert.deepEqual(store.project.surfaces[0]!.crop, { x: 0.25, y: 0, w: 0.5, h: 1 });
  store.setCrop(s.id, { w: 0, h: -3 });
  const { w, h } = store.project.surfaces[0]!.crop;
  assert.ok(w > 0 && h > 0, `janela vazia: ${w}x${h}`);
});

test('AC-38: a polygon vertex moves, and a locked surface refuses', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.setSurfaceShape(s.id, {
    kind: 'polygon',
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }],
  });
  store.setPolygonPoint(s.id, 2, { x: 0.8, y: 0.9 });
  const moved = store.project.surfaces[0]!.shape;
  assert.equal(moved.kind, 'polygon');
  assert.deepEqual(moved.kind === 'polygon' ? moved.points[2] : null, { x: 0.8, y: 0.9 });

  store.toggleLock(s.id);
  store.setPolygonPoint(s.id, 2, { x: 0.1, y: 0.1 });
  const after = store.project.surfaces[0]!.shape;
  assert.deepEqual(after.kind === 'polygon' ? after.points[2] : null, { x: 0.8, y: 0.9 });
});

test('AC-40: the generic patch enforces the same invariants as the named setters', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();

  // Values that no named setter would ever accept, through the generic door.
  store.patchSurface(s.id, {
    opacity: 5,
    rotation: 450,
    crop: { x: -1, y: 2, w: 0, h: 9 },
    fit: 'diagonal' as never,
    blend: 'glow' as never,
    name: '   ',
    z: Number.NaN,
  });

  const after = store.project.surfaces[0]!;
  assert.equal(after.opacity, 1, 'opacity clamped');
  assert.equal(after.rotation, 90, 'rotation normalised');
  assert.ok(after.crop.w > 0 && after.crop.h > 0, 'crop samples something');
  assert.ok(after.crop.x >= 0 && after.crop.y <= 1, 'crop inside the source');
  assert.equal(after.fit, 'stretch', 'unknown fit rejected');
  assert.equal(after.blend, 'normal', 'unknown blend rejected');
  assert.notEqual(after.name.trim(), '', 'blank name rejected');
  assert.ok(Number.isFinite(after.z), 'z stays a number');
});

test('AC-41: duplicate ids in a loaded project are resolved, not carried', () => {
  const store = new Store(emptyProject());
  const frame = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  store.load({
    version: 1,
    output: { width: 1920, height: 1080 },
    sources: [
      { id: 'dup', name: 'first', kind: 'color', rgb: [255, 0, 0] },
      { id: 'dup', name: 'second', kind: 'color', rgb: [0, 255, 0] },
    ],
    surfaces: [
      { id: 'same', name: 'a', frame, sourceId: 'dup' },
      { id: 'same', name: 'b', frame },
    ],
  });

  // One source survives, and it is the one the surfaces already referenced.
  assert.equal(store.project.sources.length, 1);
  assert.equal(store.project.sources[0]!.name, 'first');

  // Both surfaces survive, with ids that address them separately.
  const ids = store.project.surfaces.map((s) => s.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);

  // The clash used to make removal delete both.
  store.removeSurface(ids[0]!);
  assert.equal(store.project.surfaces.length, 1);
  assert.equal(store.project.surfaces[0]!.name, 'b');
});

test('AC-46: a locked surface refuses every warp edit', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.enableWarp(s.id);
  store.setWarpPoint(s.id, 4, { x: 0.9, y: 0.1 });
  const moved = store.project.surfaces[0]!.warp!.points[4]!;

  store.toggleLock(s.id);
  store.setWarpPoint(s.id, 4, { x: 0.1, y: 0.9 });
  store.setWarpGrid(s.id, 5, 5);
  store.resetWarp(s.id);
  store.disableWarp(s.id);

  const after = store.project.surfaces[0]!.warp;
  assert.ok(after, 'a malha continua existindo');
  assert.deepEqual(after.points[4], moved, 'o ponto não se moveu');
  assert.equal(after.cols, 2, 'a grade não mudou');
});

test('AC-48: enabling a warp changes nothing, resetting undoes everything', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.enableWarp(s.id);
  assert.ok(isIdentity(store.project.surfaces[0]!.warp!), 'nasce identidade');

  store.setWarpPoint(s.id, 0, { x: -0.2, y: -0.3 });
  assert.equal(isIdentity(store.project.surfaces[0]!.warp!), false);

  store.resetWarp(s.id);
  assert.ok(isIdentity(store.project.surfaces[0]!.warp!), 'reset volta à identidade');

  store.disableWarp(s.id);
  assert.equal(store.project.surfaces[0]!.warp, undefined);
});

test('AC-54: soft selection pulls the neighbours, and one drag is one undo', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.enableWarp(s.id, 4, 4);
  const before = structuredClone(store.project.surfaces[0]!.warp!.points);

  const centre = 12; // linha 2, coluna 2 de uma grade 5x5
  for (let i = 1; i <= 10; i++) {
    store.setWarpPoint(s.id, centre, { x: 0.5, y: 0.5 - i * 0.01 }, 2);
  }
  store.endGesture();

  const after = store.project.surfaces[0]!.warp!.points;
  assert.notDeepEqual(after[centre], before[centre], 'o ponto arrastado moveu');
  assert.notDeepEqual(after[centre - 1], before[centre - 1], 'o vizinho veio junto');
  assert.deepEqual(after[0], before[0], 'o canto distante ficou parado');

  store.undo();
  assert.deepEqual(store.project.surfaces[0]!.warp!.points, before, 'um arrasto, um desfazer');
});

test('AC-47: changing the grid keeps the shape and survives a round trip', () => {
  const store = new Store(emptyProject());
  const s = store.addSurface();
  store.enableWarp(s.id, 2, 2);
  store.setWarpPoint(s.id, 4, { x: 0.5, y: 0.2 });
  const bulge = evaluateWarp(store.project.surfaces[0]!.warp!, 0.5, 0.5);

  store.setWarpGrid(s.id, 4, 4);
  const resampled = store.project.surfaces[0]!.warp!;
  assert.equal(resampled.points.length, 25);
  const after = evaluateWarp(resampled, 0.5, 0.5);
  assert.ok(Math.abs(after.y - bulge.y) < 0.02, `${after.y} vs ${bulge.y}`);

  // E sobrevive ao disco.
  const reloaded = new Store(emptyProject());
  reloaded.load(store.toJSON());
  assert.deepEqual(reloaded.project.surfaces[0]!.warp, resampled);
});

test('AC-44: a project without a warp is untouched by the feature existing', () => {
  const store = new Store(emptyProject());
  store.addSurface();
  const json = store.toJSON();
  assert.equal(json.includes('warp'), false, 'nada de warp no arquivo');

  const reloaded = new Store(emptyProject());
  reloaded.load(json);
  assert.equal(reloaded.project.surfaces[0]!.warp, undefined);
});

/** Três superfícies num store novo, devolvidas na ordem em que foram criadas. */
function threeSurfaces(): { store: Store; ids: [string, string, string] } {
  const store = new Store();
  const a = store.addSurface();
  const b = store.addSurface();
  const c = store.addSurface();
  return { store, ids: [a.id, b.id, c.id] };
}

test('AC-65: o clique com modificador acrescenta e tira da seleção', () => {
  const { store, ids: [a, b] } = threeSurfaces();
  store.setSelection([a]);
  store.toggleSelection(b);
  assert.deepEqual(store.view.selectedIds, [a, b]);
  store.toggleSelection(a);
  assert.deepEqual(store.view.selectedIds, [b], 'tirar da seleção deixa o resto');
});

test('AC-65: um arrasto de grupo é um só desfazer', () => {
  const { store, ids: [a, b] } = threeSurfaces();
  store.setSelection([a, b]);
  const before = store.project.surfaces.map((s) => s.frame[0].x);

  // Um arrasto real dispara dezenas de mutações, como o ponteiro faz.
  for (let i = 0; i < 20; i++) store.moveSelection(5, 0);
  store.endGesture();
  const moved = store.project.surfaces.map((s) => s.frame[0].x);
  assert.equal(moved[0], (before[0] ?? 0) + 100);
  assert.equal(moved[1], (before[1] ?? 0) + 100, 'as duas andaram juntas');

  store.undo();
  assert.deepEqual(store.project.surfaces.map((s) => s.frame[0].x), before,
    'um desfazer devolve o gesto inteiro, não uma superfície');
});

test('AC-66: o âncora é o último escolhido', () => {
  const { store, ids: [a, b] } = threeSurfaces();
  store.setSelection([a]);
  assert.equal(anchorId(store.view), a);
  store.toggleSelection(b);
  assert.equal(anchorId(store.view), b, 'o recém-acrescentado passa a ser o âncora');
});

test('AC-67: superfícies ligadas se selecionam e se movem juntas', () => {
  const { store, ids: [a, b, c] } = threeSurfaces();
  store.setSelection([a, b]);
  store.linkSelected();

  store.setSelection([a]);
  assert.deepEqual(store.view.selectedIds.sort(), [a, b].sort(), 'pegar uma traz o grupo');

  const cBefore = store.project.surfaces.find((s) => s.id === c)?.frame[0].x;
  store.moveSelection(10, 0);
  store.endGesture();
  const moved = new Map(store.project.surfaces.map((s) => [s.id, s.frame[0].x]));
  assert.equal(moved.get(a), moved.get(b), 'as ligadas andaram o mesmo tanto');
  assert.equal(moved.get(c), cBefore, 'a de fora do vínculo não se mexeu');
});

test('AC-67: o vínculo sobrevive a salvar e recarregar', () => {
  const { store, ids: [a, b] } = threeSurfaces();
  store.setSelection([a, b]);
  store.linkSelected();

  const reloaded = new Store();
  reloaded.load(store.toJSON());
  const links = reloaded.project.surfaces.map((s) => s.link);
  assert.ok(links[0] && links[0] === links[1], 'as duas voltaram no mesmo grupo');
  assert.equal(links[2], undefined, 'e a terceira voltou sem vínculo nenhum');
});

test('AC-67: projeto sem vínculo continua sem a chave no JSON', () => {
  const { store } = threeSurfaces();
  assert.ok(!store.toJSON().includes('link'), 'nada de `link` para quem nunca ligou nada');
});

test('AC-68: numa seleção com uma travada, as destravadas andam e a travada não', () => {
  const { store, ids: [a, b] } = threeSurfaces();
  store.toggleLock(b);
  store.setSelection([a, b]);
  const before = new Map(store.project.surfaces.map((s) => [s.id, s.frame[0].x]));

  store.moveSelection(25, 0);
  store.endGesture();
  const after = new Map(store.project.surfaces.map((s) => [s.id, s.frame[0].x]));
  assert.equal(after.get(a), (before.get(a) ?? 0) + 25);
  assert.equal(after.get(b), before.get(b), 'travar fala sobre ela, não sobre o grupo');
});

test('AC-69: apagar uma superfície selecionada não deixa id órfão', () => {
  const { store, ids: [a, b] } = threeSurfaces();
  store.setSelection([a, b]);
  store.removeSurface(a);
  assert.deepEqual(store.view.selectedIds, [b]);

  const ids = new Set(store.project.surfaces.map((s) => s.id));
  assert.ok(store.view.selectedIds.every((id) => ids.has(id)));
});

test('AC-69: id que não existe nunca entra na seleção', () => {
  const { store, ids: [a] } = threeSurfaces();
  store.setSelection([a, 'surf_fantasma', a]);
  assert.deepEqual(store.view.selectedIds, [a], 'sem órfão e sem repetido');
});

test('AC-66: o âncora é a superfície clicada, não a que o vínculo trouxe', () => {
  const { store, ids: [a, b, c] } = threeSurfaces();
  store.setSelection([a, b]);
  store.linkSelected();

  store.setSelection([a, c]);
  assert.equal(anchorId(store.view), c, 'o último pedido continua sendo o âncora');
  assert.equal(store.view.selectedIds.length, 3, 'e o vínculo entrou junto');

  store.setSelection([a]);
  assert.equal(anchorId(store.view), a, 'clicar numa ligada mostra ela no painel, não a irmã');
});

// --- timeline ---------------------------------------------------------------

/** Duas superfícies e duas fontes, o mínimo para uma cena dizer alguma coisa. */
function showFixture(): { store: Store; a: string; b: string } {
  const store = new Store();
  const a = store.addSurface().id;
  const b = store.addSurface().id;
  store.addSource({ id: 'red', name: '', kind: 'color', rgb: [255, 0, 0] });
  store.addSource({ id: 'blue', name: '', kind: 'color', rgb: [0, 0, 255] });
  return { store, a, b };
}

test('AC-84: uma cena guarda apresentação e nunca geometria', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('primeira');

  // Depois da captura, o alinhamento muda. A cena não pode saber disso.
  store.moveSurface(a, 120, 40);
  store.endGesture();
  const moved = store.project.surfaces.find((s) => s.id === a)?.frame[0].x;

  store.goToScene(0);
  assert.equal(store.project.surfaces.find((s) => s.id === a)?.frame[0].x, moved,
    'voltar à cena não pode desfazer alinhamento');

  const scene = store.project.timeline?.scenes[0];
  const cue = scene?.cues[a] as Record<string, unknown> | undefined;
  for (const forbidden of ['frame', 'shape', 'warp', 'crop', 'rotation', 'fit', 'blend', 'z']) {
    assert.equal(cue?.[forbidden], undefined, `cue não pode guardar ${forbidden}`);
  }
});

test('AC-85: tocar não escreve no projeto', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('uma');
  store.setSurfaceSource(a, 'blue');
  store.captureScene('outra');

  const json = store.toJSON();
  const canUndoBefore = store.canUndo;

  store.play();
  store.goToScene(1, { playing: true });
  store.advanceIfDue();
  store.pause();
  store.eject();

  assert.equal(store.toJSON(), json, 'nem um byte do projeto mudou ao tocar');
  assert.equal(store.canUndo, canUndoBefore, 'nenhuma entrada nova de desfazer');
});

test('AC-86: a transição escurece até o preto e volta com o conteúdo novo', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('uma');
  store.setSurfaceSource(a, 'blue');
  store.captureScene('outra');
  store.patchScene(store.project.timeline!.scenes[1]!.id, { fade: 2 });

  const surface = () => store.project.surfaces.find((s) => s.id === a)!;
  const at = (secondsIn: number) => {
    store.setView({ playback: { sceneIndex: 1, fromIndex: 0, since: Date.now() - secondsIn * 1000, playing: true } });
    return presentationOf(store.state, surface());
  };

  const start = at(0.01);
  assert.equal(start.sourceId, 'red', 'começa mostrando o conteúdo velho');
  assert.ok(start.opacity > 0.9, `${start.opacity}`);

  const bottom = at(1);
  assert.ok(bottom.opacity < 0.02, `no fundo da transição está apagado: ${bottom.opacity}`);

  const end = at(1.99);
  assert.equal(end.sourceId, 'blue', 'sai com o conteúdo novo');
  assert.ok(end.opacity > 0.9, `${end.opacity}`);
});

test('AC-86: fade zero corta seco', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('uma');
  store.setSurfaceSource(a, 'blue');
  store.captureScene('outra');
  store.patchScene(store.project.timeline!.scenes[1]!.id, { fade: 0 });

  store.goToScene(1);
  const now = presentationOf(store.state, store.project.surfaces.find((s) => s.id === a)!);
  assert.equal(now.sourceId, 'blue');
  assert.equal(now.opacity, 1, 'sem transição não há escurecimento nenhum');
});

test('AC-87: hold zero espera o GO', () => {
  const { store } = showFixture();
  store.captureScene('uma');
  store.captureScene('outra');
  const first = store.project.timeline!.scenes[0]!.id;
  store.patchScene(first, { hold: 0, fade: 0 });

  store.goToScene(0, { playing: true });
  store.setView({ playback: { ...store.view.playback!, since: Date.now() - 60_000 } });
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 0, 'um minuto depois, continua parada esperando');
});

test('AC-88: com laço, a última volta para a primeira', () => {
  const { store } = showFixture();
  store.captureScene('uma');
  store.captureScene('outra');
  for (const s of store.project.timeline!.scenes) store.patchScene(s.id, { hold: 1, fade: 0 });
  store.setLoop(true);

  store.goToScene(1, { playing: true });
  store.setView({ playback: { ...store.view.playback!, since: Date.now() - 5000 } });
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 0);
  assert.equal(store.view.playback?.playing, true, 'e continua tocando');
});

test('AC-88: sem laço, a última pausa em vez de voltar', () => {
  const { store } = showFixture();
  store.captureScene('uma');
  store.patchScene(store.project.timeline!.scenes[0]!.id, { hold: 1, fade: 0 });
  store.goToScene(0, { playing: true });
  store.setView({ playback: { ...store.view.playback!, since: Date.now() - 5000 } });
  store.advanceIfDue();
  assert.equal(store.view.playback?.playing, false);
});

test('AC-89: a timeline sobrevive a salvar e recarregar', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('abertura');
  store.patchScene(store.project.timeline!.scenes[0]!.id, { hold: 7, fade: 3 });
  store.setLoop(true);

  const reloaded = new Store();
  reloaded.load(store.toJSON());
  const scene = reloaded.project.timeline?.scenes[0];
  assert.equal(scene?.name, 'abertura');
  assert.equal(scene?.hold, 7);
  assert.equal(scene?.fade, 3);
  assert.equal(reloaded.project.timeline?.loop, true);
  assert.equal(scene?.cues[a]?.sourceId, 'red');
});

test('AC-89: projeto sem timeline continua sem a chave no JSON', () => {
  const { store } = showFixture();
  assert.ok(!store.toJSON().includes('timeline'));
});

test('AC-89: apagar a última cena devolve o projeto ao que era', () => {
  const { store } = showFixture();
  store.captureScene('uma');
  store.removeScene(store.project.timeline!.scenes[0]!.id);
  assert.ok(!store.toJSON().includes('timeline'), 'a chave sai junto com a última cena');
});

test('AC-90: superfície criada depois da cena mantém a própria apresentação', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('antes');

  const late = store.addSurface();
  store.setSurfaceSource(late.id, 'blue');
  store.goToScene(0);

  const shown = presentationOf(store.state, store.project.surfaces.find((s) => s.id === late.id)!);
  assert.equal(shown.sourceId, 'blue', 'cena é sobreposição, não estado completo do mundo');
  assert.equal(shown.visible, true, 'e ela não some');
});

test('AC-91: mexer na apresentação ejeta a timeline; mexer na geometria não', () => {
  const { store, a } = showFixture();
  store.captureScene('uma');
  store.goToScene(0, { playing: true });

  store.moveSurface(a, 10, 10);
  store.endGesture();
  assert.ok(store.view.playback, 'corrigir alinhamento com o show rodando é uma necessidade real');

  store.setOpacity(a, 0.5);
  assert.equal(store.view.playback, null, 'mexer na opacidade devolve o controle à mão');
});

test('AC-92: tocar não troca a identidade das superfícies entregues ao renderer', () => {
  const { store, a } = showFixture();
  store.setSurfaceSource(a, 'red');
  store.captureScene('uma');
  store.goToScene(0, { playing: true });

  const fromProject = new Set(store.project.surfaces);
  for (const surface of visibleSurfaces(store.state)) {
    assert.ok(fromProject.has(surface),
      'o renderer guarda geometria num WeakMap por identidade: uma cópia furaria o cache a cada frame');
  }
});

test('AC-78: uma fonte de texto sobrevive a salvar e recarregar', () => {
  const store = new Store();
  store.addSource({
    id: 'txt', name: '', kind: 'text',
    text: 'PRIMEIRA\nSEGUNDA', family: 'serif', weight: 400, italic: true,
    color: [12, 240, 90], align: 'right', lineHeight: 1.8, tracking: 0.25,
  });

  const reloaded = new Store();
  reloaded.load(store.toJSON());
  const source = reloaded.project.sources[0];
  assert.equal(source?.kind, 'text');
  if (source?.kind !== 'text') return;
  assert.equal(source.text, 'PRIMEIRA\nSEGUNDA');
  assert.equal(source.family, 'serif');
  assert.equal(source.weight, 400);
  assert.equal(source.italic, true);
  assert.deepEqual(source.color, [12, 240, 90]);
  assert.equal(source.align, 'right');
  assert.equal(source.lineHeight, 1.8);
  assert.equal(source.tracking, 0.25);
});

test('AC-78: um projeto sem texto continua sem a chave no JSON', () => {
  const store = new Store();
  store.addSurface();
  assert.ok(!store.toJSON().includes('"text"'));
});

test('AC-78: valores impossíveis num text são corrigidos na leitura', () => {
  // `parseProject` é fronteira de confiança: entrelinha zero empilharia as
  // linhas umas sobre as outras, e família inventada não teria como desenhar.
  const store = new Store();
  store.load(JSON.stringify({
    version: 1, output: { width: 1920, height: 1080 }, surfaces: [],
    sources: [{ id: 'x', name: '', kind: 'text', text: 'oi', lineHeight: 0, family: 'comic', align: 'justify', weight: 999 }],
  }));
  const source = store.project.sources[0];
  if (source?.kind !== 'text') { assert.fail('devia ter lido a fonte de texto'); return; }
  assert.ok(source.lineHeight >= 0.5, `entrelinha corrigida: ${source.lineHeight}`);
  assert.equal(source.family, 'sans');
  assert.equal(source.align, 'center');
  assert.equal(source.weight, 700);
});

test('AC-103: pausing preserves the remaining hold when playback resumes', (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = showFixture();
  store.captureScene('first');
  store.captureScene('second');
  store.patchScene(store.project.timeline!.scenes[0]!.id, { fade: 0, hold: 5 });
  const saved = store.toJSON();
  store.play();
  now += 1000;
  store.pause();
  now += 60_000;
  store.pause(); // Repeated pause must not forget when the hold stopped.
  store.play();
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 0);
  now += 3999;
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 0);
  now++;
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 1);
  assert.equal(store.toJSON(), saved);
});

test('AC-103: pausing during a fade preserves the hold without replaying the entrance', (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const { store, a } = showFixture();
  store.setOpacity(a, 0.5);
  store.captureScene('first');
  store.captureScene('second');
  store.patchScene(store.project.timeline!.scenes[0]!.id, { fade: 2, hold: 5 });
  store.play();
  now += 500;
  store.pause();
  now += 10_000;
  store.play();
  const surface = store.project.surfaces.find((s) => s.id === a)!;
  assert.equal(presentationOf(store.state, surface).opacity, 0.5);
  now += 4999;
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 0);
  now++;
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 1);
});

test('AC-103: a parked scene gets its full hold on play', (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const { store } = showFixture();
  store.captureScene('first');
  store.captureScene('second');
  store.patchScene(store.project.timeline!.scenes[0]!.id, { fade: 0, hold: 5 });
  store.goToScene(0);
  now += 60_000;
  store.play();
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 0);
  now += 5000;
  store.play(); // Repeated play must not restart the clock.
  store.advanceIfDue();
  assert.equal(store.view.playback?.sceneIndex, 1);
});

test('AC-104: deleting an earlier scene preserves the active scene through undo and redo', () => {
  const { store } = showFixture();
  for (const name of ['A', 'B', 'C']) store.captureScene(name);
  const first = store.project.timeline!.scenes[0]!.id;
  store.goToScene(1);
  const active = currentScene(store.state)!.id;
  const observed: (string | undefined)[] = [];
  const off = store.subscribe((state) => observed.push(currentScene(state)?.id));
  store.removeScene(first);
  assert.equal(currentScene(store.state)?.id, active);
  assert.equal(store.view.playback?.sceneIndex, 0);
  assert.equal(store.view.playback?.fromIndex, null);
  store.undo();
  assert.equal(store.view.playback?.sceneIndex, 1);
  store.redo();
  assert.equal(store.view.playback?.sceneIndex, 0);
  assert.ok(observed.every((id) => id === active), 'subscribers never see an unrelated scene');
  off();
});

test('AC-104: reordering scenes preserves both ends of the active transition', () => {
  const { store } = showFixture();
  for (const name of ['A', 'B', 'C']) store.captureScene(name);
  const [a, b, c] = store.project.timeline!.scenes;
  store.goToScene(1, { playing: true });
  store.goToScene(2);
  const since = store.view.playback!.since;
  store.moveScene(a!.id, 2);
  assert.equal(currentScene(store.state)?.id, c!.id);
  assert.equal(store.project.timeline!.scenes[store.view.playback!.fromIndex!]!.id, b!.id);
  assert.equal(store.view.playback!.since, since);
  assert.equal(store.view.playback!.playing, true);
  store.undo();
  assert.equal(store.view.playback!.sceneIndex, 2);
  assert.equal(store.view.playback!.fromIndex, 1);
});

test('AC-104: deleting the active scene ejects playback instead of selecting another scene', () => {
  const { store } = showFixture();
  store.captureScene('A');
  store.captureScene('B');
  store.goToScene(0);
  store.removeScene(currentScene(store.state)!.id);
  assert.equal(store.view.playback, null);
  assert.equal(store.project.timeline!.scenes.length, 1);
});
