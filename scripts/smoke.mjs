/**
 * Smoke test against the real build, in a real browser, over file://.
 *
 * This is the check that acceptance criterion 1 and 11 actually hold: the
 * single-file build opens with no server, the console stays clean, and every
 * pixel outside a mapped surface is absolute black.
 *
 *   node scripts/smoke.mjs [--headed]
 */
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'dist/index.html');
if (!existsSync(build)) {
  console.error('dist/index.html não existe — rode `npm run build` antes.');
  process.exit(1);
}

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
}

// --- checks that need no browser ------------------------------------------

const html = readFileSync(build, 'utf8');
// Everything the app NEEDS TO RUN must be inside the file. Three things are
// allowed out: the PWA assets (optional by design), the app offering itself for
// download, and metadata — a canonical URL or a link a person clicks is not a
// resource the page loads, and SEO needs both to be absolute.
const PWA_FILES = ['./manifest.webmanifest', './icon-192.png', './sw.js', './index.html'];
const metadataOnly = /<(?:link[^>]*rel="canonical"|a\s)[^>]*>/g;
const loadable = html.replace(metadataOnly, ' ');
const external = [...loadable.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((url) => !url.startsWith('data:') && !url.startsWith('#') && !PWA_FILES.includes(url));
check('AC-14: build não carrega nada de fora do arquivo', external.length === 0, external.join(' | '));

// A service worker only updates when its own bytes change. If the version stops
// tracking the HTML, the PWA serves last month's app forever.
const swPath = resolve(root, 'dist/sw.js');
if (existsSync(swPath)) {
  const sw = readFileSync(swPath, 'utf8');
  const expected = createHash('sha256').update(readFileSync(build)).digest('hex').slice(0, 12);
  check('AC-31: service worker versionado pelo hash do build', sw.includes(expected), `esperado ${expected}`);
} else {
  check('AC-31: service worker versionado pelo hash do build', false, 'dist/sw.js não existe');
}

const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  // SwiftShader gives headless chromium a real WebGL2 implementation.
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle'],
});
// O idioma é fixado aqui, e não herdado da máquina: o editor escolhe o catálogo
// por `navigator.languages`, então um runner em inglês renderiza "surface" e os
// cliques abaixo, escritos em português, não acham nada. Rodou verde por meses
// só porque o laptop de quem rodava estava em pt-BR.
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR' });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(pathToFileURL(build).href);
await page.waitForFunction(() => Boolean(window.projMap), null, { timeout: 10_000 });

check('AC-14: build abre por file:// e monta a engine', true);

// A fresh browser context has no folder handle, even when the picker exists.
const recoveryPage = await browser.newPage({ locale: 'pt-BR' });
await recoveryPage.goto(pathToFileURL(build).href);
await recoveryPage.waitForFunction(() => Boolean(window.projMap));
await recoveryPage.evaluate(() => window.projMap.store.addSurface());
await recoveryPage.waitForFunction(() => {
  const json = localStorage.getItem('map-engine:project');
  return json && JSON.parse(json).surfaces.length === 1;
});
await recoveryPage.reload();
await recoveryPage.waitForFunction(() => Boolean(window.projMap));
const recovered = await recoveryPage.evaluate(() => ({
  picker: typeof window.showDirectoryPicker === 'function',
  surfaces: window.projMap.store.project.surfaces.length,
}));
check('AC-96: browser autosave survives reload with the folder API available',
  recovered.picker && recovered.surfaces === 1, JSON.stringify(recovered));
await recoveryPage.close();

// Drive the actual engine loop with deterministic frames; reading pixels must
// not force a render, or the check would hide the missing final frame.
const animationPage = await browser.newPage();
await animationPage.goto(pathToFileURL(build).href);
await animationPage.waitForFunction(() => Boolean(window.projMap));
const fadeFrames = await animationPage.evaluate(() => {
  const engine = window.projMap;
  engine.stop();
  const request = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  const clock = Date.now;
  const render = engine.renderer.render.bind(engine.renderer);
  let nextFrame;
  let now = clock();
  const pixels = [];
  window.requestAnimationFrame = (fn) => { nextFrame = fn; return 1; };
  window.cancelAnimationFrame = () => {};
  Date.now = () => now;
  try {
    const { store } = engine;
    const surface = store.addSurface();
    store.addSource({ id: 'white', kind: 'color', name: '', rgb: [255, 255, 255] });
    store.setSurfaceSource(surface.id, 'white');
    store.captureScene('white');
    store.patchScene(store.project.timeline.scenes[0].id, { fade: 1, hold: 0 });
    store.setOpacity(surface.id, 0);
    store.goToScene(0);
    engine.resize(100, 100);
    engine.setView({ scale: 0.04, tx: 0, ty: 0 });
    engine.renderer.render = (...args) => {
      render(...args);
      const gl = engine.renderer.gl;
      const pixel = new Uint8Array(4);
      gl.readPixels(38, 78, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      pixels.push([...pixel]);
    };
    engine.start();
    nextFrame();
    now += 750;
    nextFrame();
    now += 500;
    nextFrame();
    nextFrame(); // A static scene must sleep again after its final frame.
    return pixels;
  } finally {
    engine.stop();
    engine.renderer.render = render;
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
    Date.now = clock;
  }
});
check('AC-101: a fade draws its final pixels after skipped frames and then sleeps',
  fadeFrames.length === 3 && fadeFrames[1][0] === 128 && fadeFrames[2][0] === 255,
  JSON.stringify(fadeFrames));
const sweepFrames = await animationPage.evaluate(() => {
  const engine = window.projMap;
  engine.stop();
  const request = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  const clock = performance.now.bind(performance);
  const render = engine.renderer.render.bind(engine.renderer);
  let nextFrame;
  let now = clock();
  const hashes = [];
  window.requestAnimationFrame = (fn) => { nextFrame = fn; return 1; };
  window.cancelAnimationFrame = () => {};
  performance.now = () => now;
  try {
    const { store } = engine;
    store.load({ version: 1, output: { width: 100, height: 100 }, sources: [], surfaces: [] });
    const surface = store.addSurface();
    store.setSurfaceFrame(surface.id, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
    engine.resize(100, 100);
    engine.setView({ scale: 1, tx: 0, ty: 0 });
    engine.renderer.render = (...args) => {
      render(...args);
      const gl = engine.renderer.gl;
      const pixels = new Uint8Array(100 * 100 * 4);
      gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      hashes.push(pixels.reduce((sum, value, i) => sum + value * (i + 1), 0));
    };
    const step = () => { now += 500; nextFrame(); };
    store.setTestPattern('sweep');
    engine.start();
    step(); step(); step();
    store.setSurfacePattern(surface.id, 'none');
    step(); step();
    const stopped = hashes.length;
    store.setTestPattern('none');
    store.setSurfacePattern(surface.id, 'sweep');
    step(); step();
    store.toggleVisible(surface.id);
    step(); step();
    return { hashes, stopped };
  } finally {
    engine.stop();
    engine.renderer.render = render;
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
    performance.now = clock;
  }
});
check('AC-102: visible global and surface sweeps animate without keeping hidden patterns awake',
  sweepFrames.stopped === 4 && sweepFrames.hashes.length === 7
    && new Set(sweepFrames.hashes.slice(0, 3)).size === 3
    && sweepFrames.hashes[4] !== sweepFrames.hashes[5], JSON.stringify(sweepFrames));
await animationPage.close();

/** Reads a pixel straight out of the GL buffer, right after a forced frame. */
async function pixel(x, y) {
  return page.evaluate(([px, py]) => {
    const engine = window.projMap;
    engine.renderFrame();
    const gl = engine.renderer.gl;
    const out = new Uint8Array(4);
    // readPixels' origin is bottom-left; callers think top-left.
    gl.readPixels(px, gl.drawingBufferHeight - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [...out];
  }, [x, y]);
}

const size = await page.evaluate(() => {
  const gl = window.projMap.renderer.gl;
  return [gl.drawingBufferWidth, gl.drawingBufferHeight];
});
const [W, H] = size;

// Empty project: the projector must be completely dark.
const emptyCentre = await pixel(Math.round(W / 2), Math.round(H / 2));
check('AC-15: projeto vazio não acende nenhum pixel', emptyCentre.slice(0, 3).every((v) => v === 0), `rgb=${emptyCentre}`);

// New surface, still without a source: nothing may be drawn on the wall.
await page.getByRole('button', { name: 'superfície', exact: true }).click();
const noSource = await pixel(Math.round(W / 2), Math.round(H / 2));
check('AC-16: superfície sem fonte não põe luz no objeto', noSource.slice(0, 3).every((v) => v === 0), `rgb=${noSource}`);

// Assign a white colour source: the middle lights up, the edges stay black.
await page.getByRole('button', { name: 'cor', exact: true }).click();
await page.waitForTimeout(200);
const lit = await pixel(Math.round(W / 2), Math.round(H / 2));
check('AC-17: fonte de cor acende o interior da superfície', lit[0] > 200 && lit[1] > 200 && lit[2] > 200, `rgb=${lit}`);

for (const [name, x, y] of [['canto sup-esq', 4, 4], ['canto inf-dir', W - 5, H - 5]]) {
  const p = await pixel(x, y);
  check(`AC-15: fora da superfície é preto absoluto (${name})`, p.slice(0, 3).every((v) => v === 0), `rgb=${p}`);
}

// Ellipse mask: the corners of the frame must be cut away.
const frameCorner = await page.evaluate(() => {
  const engine = window.projMap;
  const s = engine.store.project.surfaces[0];
  engine.store.setSurfaceShape(s.id, { kind: 'ellipse', feather: 0 });
  const view = engine.view;
  const c = s.frame[0];
  const dpr = window.devicePixelRatio;
  // A few pixels inside the frame's top-left corner, in device pixels.
  return [Math.round((c.x * view.scale + view.tx) * dpr) + 6, Math.round((c.y * view.scale + view.ty) * dpr) + 6];
});
const cut = await pixel(frameCorner[0], frameCorner[1]);
check('AC-18: máscara de elipse corta os cantos do frame', cut.slice(0, 3).every((v) => v < 20), `rgb=${cut}`);
const stillLit = await pixel(Math.round(W / 2), Math.round(H / 2));
check('AC-18: centro da elipse continua aceso', stillLit[0] > 200, `rgb=${stillLit}`);

// Test patterns must reach the output.
await page.selectOption('#pattern', 'grid');
await page.waitForTimeout(100);
const gridSample = await page.evaluate(() => {
  const engine = window.projMap;
  engine.renderFrame();
  const gl = engine.renderer.gl;
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let white = 0, black = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] > 200) white++; else if (buf[i] === 0) black++;
  }
  return { white, black, total: w * h };
});
check('AC-19: padrão de teste chega na saída',
  gridSample.white > 500 && gridSample.white < gridSample.total * 0.2,
  `brancos=${gridSample.white}`);

await page.selectOption('#pattern', 'none'); // a test pattern would bypass the uv matrix

// Rotation reaches the shader: at 45 degrees the sampled window's corners fall
// outside the source, get discarded, and the lit area becomes a diamond
// inscribed in the frame. Corners dark, centre and edge midpoints lit.
const rotated = await page.evaluate(() => {
  const engine = window.projMap;
  const s = engine.store.project.surfaces[0];
  engine.store.setSurfaceShape(s.id, { kind: 'quad' });
  engine.store.setSurfaceFrame(s.id, [
    { x: 660, y: 240 }, { x: 1260, y: 240 }, { x: 1260, y: 840 }, { x: 660, y: 840 },
  ]);
  engine.store.setRotation(s.id, 45);
  engine.store.endGesture();
  const v = engine.view;
  const dpr = window.devicePixelRatio;
  const toPx = (x, y) => [Math.round((x * v.scale + v.tx) * dpr), Math.round((y * v.scale + v.ty) * dpr)];
  return {
    corner: toPx(672, 252),     // just inside the frame's top-left corner
    edgeMid: toPx(960, 252 + 8), // middle of the top edge
    centre: toPx(960, 540),
  };
});
await page.waitForTimeout(50);
const rotCorner = await pixel(...rotated.corner);
const rotEdge = await pixel(...rotated.edgeMid);
const rotCentre = await pixel(...rotated.centre);
check('AC-28: rotação de 45° corta os cantos do frame', rotCorner.slice(0, 3).every((v) => v < 20), `rgb=${rotCorner}`);
check('AC-28: meio da aresta e centro continuam acesos',
  rotEdge[0] > 200 && rotCentre[0] > 200, `aresta=${rotEdge} centro=${rotCentre}`);

await page.evaluate(() => {
  const engine = window.projMap;
  engine.store.setRotation(engine.store.project.surfaces[0].id, 0);
  engine.store.endGesture();
});

// A source that finishes loading after everything went quiet has to reach the
// wall on its own. Nothing mutates the project, the image is not animated, and
// the loop is asleep — so the only thing that can wake it is the upload itself.
// Read WITHOUT forcing a frame: forcing one would hide exactly this bug.
const lateLoad = await page.evaluate(async () => {
  const engine = window.projMap;
  const store = engine.store;
  // 1x1 opaque red PNG, so the source is a real async fetch + decode.
  const red = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  store.addSource({ id: 'late', name: 'late', kind: 'image', path: red });
  const surface = store.project.surfaces[0];
  store.setSurfaceShape(surface.id, { kind: 'quad' });
  store.setSurfaceFrame(surface.id, [
    { x: 400, y: 300 }, { x: 1500, y: 300 }, { x: 1500, y: 800 }, { x: 400, y: 800 },
  ]);
  store.setSurfaceSource(surface.id, 'late');
  store.setTestPattern('none');

  // Let the loop go idle before the image can possibly have decoded.
  await new Promise((r) => setTimeout(r, 900));

  const gl = engine.renderer.gl;
  const out = new Uint8Array(4);
  gl.readPixels(
    Math.round(gl.drawingBufferWidth / 2),
    Math.round(gl.drawingBufferHeight / 2),
    1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out,
  );
  return [...out];
});
check('AC-39: fonte que carrega depois do loop dormir chega na parede sozinha',
  lateLoad[0] > 200 && lateLoad[1] < 60 && lateLoad[2] < 60, `rgb=${lateLoad}`);

await page.evaluate(() => {
  const store = window.projMap.store;
  store.removeSource('late');
});

// Trap 1: perspective-correct UV. A homography maps straight lines to straight
// lines, so on a strongly skewed quad the boundary between two colour bars must
// stay straight. The classic linearly-interpolated-UV bug kinks it exactly at
// the diagonal where the two triangles meet.
await page.evaluate(() => {
  const engine = window.projMap;
  const s = engine.store.project.surfaces[0];
  engine.store.setSurfaceShape(s.id, { kind: 'quad' });
  engine.store.setSurfaceFrame(s.id, [
    { x: 220, y: 140 }, { x: 1680, y: 60 }, { x: 1820, y: 980 }, { x: 90, y: 1040 },
  ]);
  engine.store.setTestPattern('bars');
});
await page.waitForTimeout(100);
const straightness = await page.evaluate(() => {
  const engine = window.projMap;
  engine.renderFrame();
  const gl = engine.renderer.gl;
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const at = (x, y) => (y * w + x) * 4;

  // The first bar is white, the second yellow: the boundary is where blue drops.
  const pts = [];
  for (let row = 0; row < h; row++) {
    for (let x = 1; x < w; x++) {
      const i0 = at(x - 1, row), i1 = at(x, row);
      // white (255,255,255) -> yellow (255,255,0): only the blue channel drops.
      // Green must stay high, or the magenta->red boundary further right matches too.
      const white = buf[i0] > 200 && buf[i0 + 1] > 200 && buf[i0 + 2] > 200;
      const yellow = buf[i1] > 200 && buf[i1 + 1] > 200 && buf[i1 + 2] < 60;
      if (white && yellow) {
        pts.push([x, row]);
        break;
      }
    }
  }
  if (pts.length < 20) return { count: pts.length, maxResidual: Infinity };

  // Least-squares fit of x = a*y + b, then the worst deviation from it.
  const n = pts.length;
  const sy = pts.reduce((t, p) => t + p[1], 0);
  const sx = pts.reduce((t, p) => t + p[0], 0);
  const syy = pts.reduce((t, p) => t + p[1] * p[1], 0);
  const sxy = pts.reduce((t, p) => t + p[0] * p[1], 0);
  const a = (n * sxy - sx * sy) / (n * syy - sy * sy);
  const b = (sx - a * sy) / n;
  const maxResidual = Math.max(...pts.map(([x, y]) => Math.abs(x - (a * y + b))));
  return { count: pts.length, maxResidual };
});
check('AC-20: UV com correção de perspectiva — borda reta, sem dobra diagonal',
  straightness.maxResidual <= 1.5,
  `amostras=${straightness.count} desvio máx=${straightness.maxResidual.toFixed(2)}px`);

await page.selectOption('#pattern', 'none');

// Per-surface test pattern: one surface can override the global one while its
// neighbour keeps it. Both get the same white colour source, then one is told
// to draw black — if the override reaches the GPU, only that one goes dark.
const spots = await page.evaluate(() => {
  const engine = window.projMap;
  const store = engine.store;
  const src = store.project.sources[0].id;

  const a = store.project.surfaces[0];
  store.setSurfaceShape(a.id, { kind: 'quad' });
  store.setSurfaceFrame(a.id, [
    { x: 200, y: 200 }, { x: 800, y: 200 }, { x: 800, y: 700 }, { x: 200, y: 700 },
  ]);
  store.setSurfaceSource(a.id, src);

  const b = store.addSurface();
  store.setSurfaceFrame(b.id, [
    { x: 1000, y: 200 }, { x: 1700, y: 200 }, { x: 1700, y: 700 }, { x: 1000, y: 700 },
  ]);
  store.setSurfaceSource(b.id, src);

  store.setTestPattern('none');
  store.setSurfacePattern(a.id, 'black');

  const v = engine.view;
  const dpr = window.devicePixelRatio;
  const toPx = (x, y) => [Math.round((x * v.scale + v.tx) * dpr), Math.round((y * v.scale + v.ty) * dpr)];
  return { a: toPx(500, 450), b: toPx(1350, 450), ids: [a.id, b.id] };
});
await page.waitForTimeout(80);
const patched = await pixel(...spots.a);
const untouched = await pixel(...spots.b);
check('AC-32: padrão próprio de uma superfície vale só nela',
  patched.slice(0, 3).every((v) => v === 0), `rgb=${patched}`);
check('AC-32: a vizinha continua seguindo o padrão global',
  untouched[0] > 200, `rgb=${untouched}`);

await page.evaluate((ids) => {
  const store = window.projMap.store;
  store.setSurfacePattern(ids[0], null);
  store.removeSurface(ids[1]);
}, spots.ids);

// The mesh path is a different code path, a different shader branch and a
// different vertex layout. Two things must hold: an identity warp must not
// change the picture, and no mesh may show its seams — a dark line between
// cells would be the exact artifact this project refuses, since black is
// transparency and a seam is a stripe of wall showing through the content.
const mesh = await page.evaluate(() => {
  const engine = window.projMap;
  const store = engine.store;
  const gl = engine.renderer.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;

  const surface = store.project.surfaces[0];
  store.setSurfaceShape(surface.id, { kind: 'quad' });
  store.setSurfaceFrame(surface.id, [
    { x: 300, y: 200 }, { x: 1500, y: 260 }, { x: 1450, y: 850 }, { x: 260, y: 800 },
  ]);
  store.setSurfaceSource(surface.id, store.project.sources[0].id);
  store.setTestPattern('none');

  /** Lit pixels, plus the longest run and the number of gaps on a mid scanline. */
  const measure = () => {
    engine.renderFrame();
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    let lit = 0;
    for (let i = 0; i < buf.length; i += 4) if (buf[i] > 200) lit++;

    const row = Math.round(h / 2);
    let runs = 0;
    let inRun = false;
    let longest = 0;
    let current = 0;
    for (let x = 0; x < w; x++) {
      const on = buf[(row * w + x) * 4] > 200;
      if (on) {
        current++;
        if (!inRun) { runs++; inRun = true; }
      } else {
        longest = Math.max(longest, current);
        current = 0;
        inRun = false;
      }
    }
    return { lit, runs, longest: Math.max(longest, current) };
  };

  const plain = measure();
  store.enableWarp(surface.id);
  const identity = measure();
  store.setWarpPoint(surface.id, 4, { x: 0.5, y: 0.2 }, 1.5);
  store.endGesture();
  const bent = measure();
  store.disableWarp(surface.id);

  return { plain, identity, bent, id: surface.id };
});

const drift = Math.abs(mesh.identity.lit - mesh.plain.lit) / mesh.plain.lit;
check('AC-44: malha identidade desenha o mesmo que nenhuma malha',
  drift < 0.005 && mesh.identity.runs === mesh.plain.runs,
  `desvio=${(drift * 100).toFixed(3)}% trechos=${mesh.plain.runs}/${mesh.identity.runs}`);

check('AC-49: a malha não mostra costura entre células',
  mesh.identity.runs === 1 && mesh.bent.runs === 1,
  `identidade=${mesh.identity.runs} trecho(s), deformada=${mesh.bent.runs}`);

check('AC-49: mover um ponto de controle muda o que chega na parede',
  mesh.bent.lit !== mesh.identity.lit && mesh.bent.lit > 0,
  `identidade=${mesh.identity.lit} deformada=${mesh.bent.lit}`);

await page.selectOption('#pattern', 'none');

// A warped surface still has to respect its cutout. The polygon stops being the
// geometry once a mesh is drawing, so it moves into a mask texture — and the
// test is the same one that mattered for the ellipse: the corners of the frame
// have to stay dark while the middle stays lit.
const maskedMesh = await page.evaluate(() => {
  const engine = window.projMap;
  const store = engine.store;
  const gl = engine.renderer.gl;
  const surface = store.project.surfaces[0];

  store.setSurfaceFrame(surface.id, [
    { x: 500, y: 250 }, { x: 1400, y: 250 }, { x: 1400, y: 830 }, { x: 500, y: 830 },
  ]);
  store.setSurfaceSource(surface.id, store.project.sources[0].id);
  store.setTestPattern('none');
  // Losango: os quatro cantos do frame ficam de fora.
  store.setSurfaceShape(surface.id, {
    kind: 'polygon',
    points: [{ x: 0.5, y: 0 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }, { x: 0, y: 0.5 }],
  });
  store.enableWarp(surface.id);

  const v = engine.view;
  const dpr = window.devicePixelRatio;
  const at = (x, y) => {
    engine.renderFrame();
    const out = new Uint8Array(4);
    gl.readPixels(
      Math.round((x * v.scale + v.tx) * dpr),
      gl.drawingBufferHeight - Math.round((y * v.scale + v.ty) * dpr),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out,
    );
    return [...out];
  };

  const centre = at(950, 540);
  const corner = at(520, 270);
  store.disableWarp(surface.id);
  store.setSurfaceShape(surface.id, { kind: 'quad' });
  return { centre, corner };
});
check('AC-52: máscara de polígono continua recortando numa superfície deformada',
  maskedMesh.centre[0] > 200 && maskedMesh.corner.slice(0, 3).every((v) => v < 20),
  `centro=${maskedMesh.centre} canto=${maskedMesh.corner}`);

// Undo must walk the geometry back.
const undoOk = await page.evaluate(() => {
  const engine = window.projMap;
  const s = engine.store.project.surfaces[0];
  const before = s.frame[0].x;
  engine.store.setCorner(s.id, 0, { x: before - 100, y: s.frame[0].y });
  engine.store.endGesture();
  const moved = engine.store.project.surfaces[0].frame[0].x;
  engine.store.undo();
  return { before, moved, after: engine.store.project.surfaces[0].frame[0].x };
});
check('AC-7: desfazer volta o canto arrastado pela UI real', undoOk.after === undoOk.before && undoOk.moved !== undoOk.before, JSON.stringify(undoOk));

// A timeline com o relógio de verdade. Os testes de unidade já cobrem a
// matemática; o que só aparece aqui é o laço real de `requestAnimationFrame`
// batendo por segundos seguidos sem encostar no projeto.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.sources]) store.removeSource(s.id);
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  const surface = store.addSurface();
  const { width, height } = store.project.output;
  store.setSurfaceFrame(surface.id, [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
  store.addSource({ id: 'red', name: '', kind: 'color', rgb: [255, 0, 0] });
  store.addSource({ id: 'green', name: '', kind: 'color', rgb: [0, 255, 0] });
  store.setSurfaceSource(surface.id, 'red');
  store.captureScene('vermelha');
  store.setSurfaceSource(surface.id, 'green');
  store.captureScene('verde');
  const scenes = store.project.timeline.scenes;
  store.patchScene(scenes[0].id, { hold: 0.4, fade: 0 });
  store.patchScene(scenes[1].id, { hold: 0.4, fade: 0 });
  store.setLoop(true);
  store.eject();
});
await page.waitForTimeout(250);

const showBefore = await page.evaluate(() => ({
  json: window.projMap.store.toJSON(),
  canUndo: window.projMap.store.canUndo,
}));
await page.evaluate(() => window.projMap.store.play());
await page.waitForTimeout(2200);
const showAfter = await page.evaluate(() => ({
  json: window.projMap.store.toJSON(),
  canUndo: window.projMap.store.canUndo,
  index: window.projMap.store.view.playback?.sceneIndex ?? -1,
  cycled: window.projMap.store.view.playback?.playing === true,
}));
await page.evaluate(() => window.projMap.store.eject());
check('AC-85: um ciclo inteiro de timeline não escreve um byte no projeto',
  showBefore.json === showAfter.json && showBefore.canUndo === showAfter.canUndo && showAfter.cycled,
  `json igual=${showBefore.json === showAfter.json} desfazer igual=${showBefore.canUndo === showAfter.canUndo} parou na cena ${showAfter.index}`);

// Texto como conteúdo. O que se prova aqui é o encaixe com a regra central da
// ferramenta: preto é ausência de luz, então uma fonte de texto não precisa —
// nem pode — pintar fundo nenhum.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.sources]) store.removeSource(s.id);
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  const surface = store.addSurface();
  const { width, height } = store.project.output;
  store.setSurfaceFrame(surface.id, [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
  store.addSource({
    id: 'txt', name: '', kind: 'text',
    // Vermelho puro de propósito: um fundo pintado apareceria como verde ou
    // azul acesos, e nenhuma outra medição distingue isso tão bem.
    text: 'MAPA', family: 'sans', weight: 700, italic: false,
    color: [255, 0, 0], align: 'center', lineHeight: 1.15, tracking: 0,
  });
  store.setSurfaceSource(surface.id, 'txt');
});
// O pool só sincroniza dentro do laço da engine, nunca num `renderFrame` avulso.
await page.waitForTimeout(400);

const text = await page.evaluate(() => {
  const engine = window.projMap;
  engine.renderFrame();
  const gl = engine.renderer.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let lit = 0;
  let painted = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i] ?? 0, g = buf[i + 1] ?? 0, b = buf[i + 2] ?? 0;
    if (r === 0 && g === 0 && b === 0) continue;
    lit++;
    if (g > 12 || b > 12) painted++;
  }
  const source = engine.pool.get('txt');
  return { lit, painted, size: source?.size ?? [0, 0], status: source?.status };
});
check('AC-74: a fonte de texto acende só os glifos, sem fundo pintado',
  text.status === 'ready' && text.lit > 0 && text.painted === 0,
  `acesos=${text.lit} com fundo=${text.painted}`);
check('AC-76: a textura é a caixa do texto, no limite de 2048',
  Math.max(...text.size) === 2048 && Math.min(...text.size) > 0,
  `textura=${text.size.join('x')}`);

// Orientação. Este defeito passou por todo teste de pixel que só conta brilho e
// cor: o texto subia de cabeça para baixo e as contagens continuavam batendo.
const upright = await page.evaluate(async () => {
  const { store } = window.projMap;
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  // Imagem de orientação conhecida ao lado do texto, no mesmo frame: se um dia
  // o flip mudar para todo mundo, a metade da imagem denuncia junto.
  const c = document.createElement('canvas');
  c.width = 4; c.height = 4;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 4, 2);
  g.fillStyle = '#000'; g.fillRect(0, 2, 4, 2);

  const { width, height } = store.project.output;
  const place = (x, w) => {
    const s = store.addSurface();
    store.setSurfaceFrame(s.id, [{ x, y: 0 }, { x: x + w, y: 0 }, { x: x + w, y: height }, { x, y: height }]);
    return s.id;
  };
  const left = place(0, width / 2);
  const right = place(width / 2, width / 2);
  store.addSource({ id: 'topHalf', name: '', kind: 'image', path: c.toDataURL('image/png') });
  store.addSource({
    id: 'letter', name: '', kind: 'text',
    // 'F' tem a barra grossa em cima: mais tinta no topo que na base.
    text: 'F', family: 'sans', weight: 700, italic: false,
    color: [255, 255, 255], align: 'center', lineHeight: 1, tracking: 0,
  });
  store.setSurfaceSource(left, 'topHalf');
  store.setSurfaceSource(right, 'letter');
  await new Promise((r) => setTimeout(r, 600));

  const engine = window.projMap;
  engine.renderFrame();
  const gl = engine.renderer.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const ink = (x0, x1, y0, y1) => {
    let n = 0;
    for (let screenY = y0; screenY < y1; screenY++) {
      const y = h - 1 - screenY;           // readPixels tem origem embaixo
      for (let x = x0; x < x1; x++) if ((buf[(y * w + x) * 4] ?? 0) > 180) n++;
    }
    return n;
  };
  const half = Math.floor(w / 2);
  const third = Math.floor(h / 3);
  return {
    image: { top: ink(0, half, 0, third), bottom: ink(0, half, 2 * third, h) },
    text: { top: ink(half, w, 0, third), bottom: ink(half, w, 2 * third, h) },
  };
});
check('AC-93: texto e imagem sobem na orientação certa, não de cabeça para baixo',
  upright.image.top > upright.image.bottom && upright.text.top > upright.text.bottom,
  `imagem ${upright.image.top}/${upright.image.bottom} texto ${upright.text.top}/${upright.text.bottom}`);

const kept = await page.evaluate(() => {
  const engine = window.projMap;
  const before = engine.pool.get('txt');
  engine.store.patchSource('txt', { text: 'MAPA VIVO' });
  return { same: engine.pool.get('txt') === before };
});
check('AC-75: digitar remenda a fonte em vez de reconstruí-la', kept.same,
  'reconstruir jogaria a textura fora e piscaria na parede a cada tecla');

// Raio-x. O critério que importa não é o que ele desenha: é o que ele **não**
// toca. Um modo de diagnóstico que chegue ao projetor no meio de uma
// inauguração é um desastre.
const glHash = () => page.evaluate(() => {
  const engine = window.projMap;
  engine.renderFrame();
  const gl = engine.renderer.gl;
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let hash = 0;
  for (let i = 0; i < buf.length; i++) hash = (hash * 31 + (buf[i] ?? 0)) >>> 0;
  return hash;
});

await page.evaluate(() => {
  const { store } = window.projMap;
  store.addSurface();
  const extra = store.addSurface();
  store.toggleVisible(extra.id);   // uma escondida, que o raio-x tem que achar
  store.setView({ xray: false });
});
await page.waitForTimeout(150);
const xrayOff = await glHash();
await page.evaluate(() => window.projMap.store.setView({ xray: true }));
await page.waitForTimeout(200);
const xrayOn = await glHash();
check('AC-81: o raio-x não muda um pixel do que a engine desenha',
  xrayOff === xrayOn, `${xrayOff} contra ${xrayOn}`);

const xrayShapes = await page.evaluate(() => ({
  shapes: document.querySelectorAll('.xray-shape').length,
  surfaces: window.projMap.store.project.surfaces.length,
  hidden: window.projMap.store.project.surfaces.filter((s) => !s.visible).length,
}));
check('AC-80: toda superfície ganha silhueta no raio-x, inclusive a escondida',
  xrayShapes.shapes === xrayShapes.surfaces && xrayShapes.hidden > 0,
  `silhuetas=${xrayShapes.shapes} superfícies=${xrayShapes.surfaces} escondidas=${xrayShapes.hidden}`);

await page.evaluate(() => window.projMap.store.setView({ uiHidden: true }));
await page.waitForTimeout(150);
const whenHidden = await page.evaluate(() => document.querySelectorAll('.xray-shape').length);
await page.evaluate(() => window.projMap.store.setView({ uiHidden: false, xray: false }));
check('AC-82: esconder a interface apaga o raio-x junto', whenHidden === 0,
  `${whenHidden} silhuetas com a interface escondida`);

// O seletor de cor abria dentro da lista, empurrava o painel e obrigava a rolar
// até achá-lo — escondendo justamente a parede, que é o que se olha ao escolher
// uma cor. E não dizia como fechar.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.sources]) store.removeSource(s.id);
  store.addSource({ id: 'pick', name: '', kind: 'color', rgb: [208, 43, 43] });
});
await page.waitForTimeout(120);

const page_height = () => page.evaluate(() => document.documentElement.scrollHeight);
const dialogs = () => page.locator('[role=dialog]').count();
const openPicker = async () => {
  await page.getByRole('button', { name: 'escolher a cor' }).first().click();
  await page.waitForSelector('[role=dialog]', { timeout: 3000 });
};

const heightClosed = await page_height();
await openPicker();
const heightOpen = await page_height();
const boxPicker = await page.locator('[role=dialog]').boundingBox();
const viewport = page.viewportSize();
const insideScreen = !!boxPicker && boxPicker.x >= 0 && boxPicker.y >= 0
  && boxPicker.x + boxPicker.width <= viewport.width + 1
  && boxPicker.y + boxPicker.height <= viewport.height + 1;
check('AC-72: o seletor de cor flutua sem empurrar a página, e cabe na tela',
  heightOpen === heightClosed && insideScreen,
  `altura ${heightClosed}->${heightOpen} caixa=${JSON.stringify(boxPicker)}`);

await page.keyboard.press('Escape');
const byEsc = await dialogs() === 0;
await openPicker();
await page.mouse.click(Math.round(viewport.width / 2), Math.round(viewport.height / 2));
const byOutside = await dialogs() === 0;
await openPicker();
await page.getByRole('button', { name: 'pronto' }).click();
const byButton = await dialogs() === 0;
check('AC-72: fecha por Esc, por clique fora e pelo botão',
  byEsc && byOutside && byButton, `esc=${byEsc} fora=${byOutside} botão=${byButton}`);

// Seleção múltipla, arrasto de grupo, e a vista que não se perde. Tudo com
// ponteiro de verdade: é a camada onde os três defeitos moravam.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  const place = (x) => {
    const s = store.addSurface();
    store.setSurfaceFrame(s.id, [{ x, y: 200 }, { x: x + 300, y: 200 }, { x: x + 300, y: 500 }, { x, y: 500 }]);
  };
  place(100); place(500); place(900);
  store.setSelection([]);
});
/**
 * Pixel de saída -> pixel da página, lendo a transformação que o engine está
 * mesmo usando. Repetir a conta do `fitView` aqui amarraria cada checagem ao
 * enquadramento padrão, e a primeira que mexesse na vista quebraria as de baixo.
 */
const outXY = (ox, oy) => page.evaluate(([ox, oy]) => {
  const rect = document.querySelector('canvas').getBoundingClientRect();
  const { scale, tx, ty } = window.projMap.view;
  return { x: rect.left + ox * scale + tx, y: rect.top + oy * scale + ty };
}, [ox, oy]);
const frames = () => page.evaluate(() => window.projMap.store.project.surfaces.map((s) => s.frame[0].x));

// Laço em volta das duas primeiras, sem tocar na terceira.
let from = await outXY(50, 150);
let to = await outXY(850, 550);
await page.mouse.move(from.x, from.y);
await page.mouse.down();
await page.mouse.move(to.x, to.y, { steps: 10 });
await page.mouse.up();
const caught = await page.evaluate(() => window.projMap.store.view.selectedIds.length);

const beforeDrag = await frames();
const grab = await outXY(250, 350);
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(grab.x + 60, grab.y, { steps: 10 });
await page.mouse.up();
const afterDrag = await frames();
await page.evaluate(() => window.projMap.store.undo());
const undoneDrag = await frames();

const moved = afterDrag.map((x, i) => x - (beforeDrag[i] ?? 0));
check('AC-65: laço pega várias e o arrasto move o grupo num só desfazer',
  caught === 2 && moved[0] > 1 && Math.abs(moved[0] - (moved[1] ?? 0)) < 1e-9 && moved[2] === 0
  && JSON.stringify(undoneDrag) === JSON.stringify(beforeDrag),
  `pegou=${caught} deslocou=${moved.map((m) => m.toFixed(1))}`);

// Ctrl + arrastar reenquadra: a vista anda, a superfície não.
const stillBefore = await frames();
await page.keyboard.down('Control');
await page.mouse.move(grab.x, grab.y);
await page.mouse.down();
await page.mouse.move(grab.x + 90, grab.y + 50, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Control');
check('AC-71: Ctrl + arrastar reenquadra sem mover superfície',
  JSON.stringify(await frames()) === JSON.stringify(stillBefore),
  JSON.stringify(await frames()));

// Afastar muito e arrastar para longe costumava perder a saída de vista.
const centre = await outXY(960, 540);
await page.mouse.move(centre.x, centre.y);
for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 400);
await page.keyboard.down('Control');
for (let i = 0; i < 6; i++) {
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  await page.mouse.move(centre.x + 600, centre.y + 400, { steps: 5 });
  await page.mouse.up();
}
await page.keyboard.up('Control');

const reachable = await page.evaluate(() => {
  const engine = window.projMap;
  const { store } = engine;
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  const s = store.addSurface();
  const { width, height } = store.project.output;
  store.setSurfaceFrame(s.id, [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]);
  store.addSource({ id: 'probe', name: '', kind: 'color', rgb: [255, 255, 255] });
  store.setSurfaceSource(s.id, 'probe');
  engine.renderFrame();
  const gl = engine.renderer.gl;
  const px = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
  gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let lit = 0;
  for (let i = 0; i < px.length; i += 4) if ((px[i] ?? 0) > 200) lit++;
  return lit;
});
check('AC-70: a saída continua alcançável depois de afastar e arrastar longe',
  reachable > 0, `pixels visíveis=${reachable}`);

// Devolve o enquadramento padrão: as checagens abaixo calculam a posição na
// tela a partir dele, e este bloco deixou a vista longe de propósito.
await page.getByRole('button', { name: 'enquadrar', exact: true }).click();
await page.waitForTimeout(80);

// Empilhar superfícies. Um fundo cobrindo a saída é o caso mais comum que
// existe, e era exatamente onde as duas coisas quebravam.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.sources]) store.removeSource(s.id);
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  const { width, height } = store.project.output;
  // A pequena nasce PRIMEIRO e o fundo depois, de propósito: assim a ordem do
  // array diverge da ordem de `z`, que é onde o clique discordava do desenho.
  const small = store.addSurface();
  store.setSurfaceFrame(small.id, [
    { x: width * 0.3, y: height * 0.3 }, { x: width * 0.7, y: height * 0.3 },
    { x: width * 0.7, y: height * 0.7 }, { x: width * 0.3, y: height * 0.7 },
  ]);
  const back = store.addSurface();
  store.setSurfaceFrame(back.id, [
    { x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height },
  ]);
  store.addSource({ id: 'front', name: '', kind: 'color', rgb: [0, 255, 0] });
  store.addSource({ id: 'back', name: '', kind: 'color', rgb: [180, 0, 0] });
  store.setSurfaceSource(small.id, 'front');
  store.setSurfaceSource(back.id, 'back');
  store.reorder(back.id, -10);
  store.reorder(small.id, 5);
  store.setSelection([]);
  window.__stack = { small: small.id, back: back.id };
});
await page.waitForTimeout(300);

// Esc devolve a ferramenta de seleção: um bloco anterior pode ter deixado o
// polígono na mão, e aí o clique abaixo mediria outra coisa.
await page.keyboard.press('Escape');
await page.waitForTimeout(80);

// `pixel` lê o buffer de desenho; `outXY` fala em pixels de saída. As duas
// unidades são diferentes, e trocá-las põe o clique num lugar que não é o
// centro de nada.
const out = await page.evaluate(() => window.projMap.store.project.output);
const drawn = await pixel(Math.round(W / 2), Math.round(H / 2));
const middle = await outXY(out.width / 2, out.height / 2);
await page.mouse.click(middle.x, middle.y);
const picked = await page.evaluate(() => window.projMap.store.view.selectedIds[0] === window.__stack.small);
check('AC-94: o clique pega a superfície que está por cima no desenho',
  drawn[1] > 200 && drawn[0] < 60 && picked,
  `pixel=${drawn.slice(0, 3)} pegou a de cima=${picked}`);

// Traçar um contorno por cima de um fundo que já existe.
const before = await page.evaluate(() => window.projMap.store.project.surfaces.length);
await page.getByRole('button', { name: 'polígono', exact: true }).first().click();
for (const [fx, fy] of [[0.15, 0.15], [0.45, 0.15], [0.3, 0.4]]) {
  const spot = await outXY(out.width * fx, out.height * fy);
  await page.mouse.click(spot.x, spot.y);
}
const last = await outXY(out.width * 0.3, out.height * 0.4);
await page.mouse.dblclick(last.x, last.y);
await page.waitForTimeout(200);
const after = await page.evaluate(() => window.projMap.store.project.surfaces.length);
check('AC-95: dá para traçar um polígono por cima de uma superfície existente',
  after === before + 1, `superfícies ${before} -> ${after}`);

// E devolve a ferramenta, senão todo ponteiro daqui para baixo traça polígono.
await page.keyboard.press('Escape');
await page.waitForTimeout(80);



// Toda fonte de cor nascia chamada "branco" e continuava assim depois de trocar
// a cor: cinco fontes "branco" de cores diferentes numa lista é o que sobra
// depois de calibrar um projetor. E o que o hex diz tem que ser o que acende.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.sources]) store.removeSource(s.id);
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  store.addSurface();
  store.addSource({ id: 'c1', name: '', kind: 'color', rgb: [255, 255, 255] });
  store.setSurfaceSource(store.project.surfaces[0].id, 'c1');
});
await page.waitForTimeout(120);

const colour = await page.evaluate(() => {
  const { store, renderer } = window.projMap;
  const label = () => [...document.querySelectorAll('span.truncate')]
    .map((s) => s.textContent.trim()).find((x) => x.includes('#')) ?? '';
  const asWhite = label();
  store.setSourceColor('c1', [208, 43, 43]);
  return { asWhite, asRed: label() };
});
await page.waitForTimeout(120);
const named = await page.evaluate(() => [...document.querySelectorAll('span.truncate')]
  .map((s) => s.textContent.trim()).find((x) => x.includes('#')) ?? '');
check('AC-63: o nome da fonte de cor acompanha a cor',
  colour.asWhite.includes('#ffffff') && named.includes('#d02b2b') && named !== colour.asWhite,
  `${colour.asWhite} -> ${named}`);

const litColour = await pixel(Math.round(W / 2), Math.round(H / 2));
check('AC-64: o que o hex diz é o que a superfície acende',
  litColour[0] === 208 && litColour[1] === 43 && litColour[2] === 43,
  `rgb=${litColour.slice(0, 3)}`);

// O guia da malha só serve se for visível sobre o conteúdo — e é sobre a imagem
// que se julga o alinhamento. Medido no elemento renderizado de verdade, com o
// CSS aplicado, e não na folha de estilo.
await page.evaluate(() => {
  const { store } = window.projMap;
  if (!store.project.surfaces[0]) store.addSurface();
  const s = store.project.surfaces[0];
  store.setSelection([s.id]);
  store.enableWarp(s.id);
});
// O overlay é Svelte: as alças só existem no DOM depois que ele pinta.
await page.waitForSelector('.warp-casing', { state: 'attached', timeout: 5000 });

const contrast = await page.evaluate(() => {
  const read = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const css = getComputedStyle(el);
    const rgb = css.stroke.match(/[\d.]+/g)?.map(Number) ?? null;
    return rgb && { rgb: rgb.slice(0, 3), alpha: Number(css.opacity) };
  };
  const casing = read('.warp-casing');
  const line = read('.warp-line');
  if (!casing || !line) return null;

  // Luminância relativa da WCAG, e a razão de contraste entre duas cores.
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const over = (fg, alpha, bg) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

  const measure = (bg) => {
    const cased = over(casing.rgb, casing.alpha, bg);
    return Math.max(ratio(cased, bg), ratio(over(line.rgb, line.alpha, cased), bg));
  };
  return { branco: measure([255, 255, 255]), preto: measure([0, 0, 0]) };
});
check('AC-61: o guia da malha se distingue sobre branco e sobre preto',
  contrast !== null && contrast.branco >= 2 && contrast.preto >= 2,
  contrast ? `branco=${contrast.branco.toFixed(2)}x preto=${contrast.preto.toFixed(2)}x` : 'elementos do guia não encontrados');

// O clique tem que respeitar a silhueta, e não a caixa. Um polígono ocupa uma
// fração da própria bbox, então o canto vazio dela é o lugar exato onde
// selecionar a superfície errada custa caro: acontece em cima de uma escada,
// mirando outra coisa.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  store.addSurface();
  const s = store.project.surfaces[0];
  store.setSurfaceShape(s.id, { kind: 'polygon', points: [{ x: 0.05, y: 0.05 }, { x: 0.75, y: 0.25 }, { x: 0.2, y: 0.8 }] });
  store.setSelection([]);
  // Espaço de frame -> página, pela vista real. Mesmo motivo de `outXY`.
  window.__xy = (u, v) => {
    const rect = document.querySelector('canvas').getBoundingClientRect();
    const { scale, tx, ty } = window.projMap.view;
    const f = window.projMap.store.project.surfaces[0].frame;
    const ox = f[0].x + (f[1].x - f[0].x) * u + (f[3].x - f[0].x) * v;
    const oy = f[0].y + (f[1].y - f[0].y) * u + (f[3].y - f[0].y) * v;
    return { x: rect.left + ox * scale + tx, y: rect.top + oy * scale + ty };
  };
});
const at = (u, v) => page.evaluate(([u, v]) => window.__xy(u, v), [u, v]);
const selected = () => page.evaluate(() => window.projMap.store.view.selectedIds[0] ?? null);

let spot = await at(0.9, 0.9);
await page.mouse.click(spot.x, spot.y);
const emptyCorner = await selected();
spot = await at(0.3, 0.3);
await page.mouse.click(spot.x, spot.y);
const insideShape = await selected();
check('AC-59: o clique respeita o polígono, não a caixa dele',
  emptyCorner === null && insideShape !== null,
  `cantoVazio=${emptyCorner} dentro=${insideShape}`);

// Vértice interno de propósito: num canto do frame a alça do canto fica por cima.
const vertex = () => page.evaluate(() => {
  const p = window.projMap.store.project.surfaces[0].shape.points[1];
  return { x: p.x, y: p.y };
});
const vBefore = await vertex();
const vertexGrab = await at(vBefore.x, vBefore.y);
await page.mouse.move(vertexGrab.x, vertexGrab.y);
await page.mouse.down();
await page.mouse.move(vertexGrab.x - 150, vertexGrab.y + 60, { steps: 12 });
await page.mouse.up();
const vAfter = await vertex();
await page.evaluate(() => window.projMap.store.undo());
const vUndone = await vertex();
check('AC-60: vértice de polígono se move e volta num só desfazer',
  Math.abs(vAfter.x - vBefore.x) > 0.005 && Math.abs(vUndone.x - vBefore.x) < 1e-9,
  `${vBefore.x.toFixed(3)} -> ${vAfter.x.toFixed(3)} -> ${vUndone.x.toFixed(3)}`);

// O número da lista tem que ser o mesmo que o projetor desenha. Quem está na
// escada lê os dois ao mesmo tempo; divergir seria pior do que não numerar.
await page.evaluate(() => {
  const { store } = window.projMap;
  for (const s of [...store.project.surfaces]) store.removeSurface(s.id);
  store.addSurface(); store.addSurface(); store.addSurface();
  // A última superfície vai para o topo da pilha: se a lista numerasse por
  // ordem de criação em vez de por z, esta é a linha que denunciaria.
  const [a, , c] = store.project.surfaces;
  store.reorder(c.id, 10);
  store.reorder(a.id, -5);
});
await page.waitForFunction(() => document.querySelectorAll('aside li, .surface-row').length > 0
  || document.querySelectorAll('li').length > 0, null, { timeout: 5000 });

const numbering = await page.evaluate(() => {
  const { store } = window.projMap;
  // O que o renderer projeta: z decrescente, começando em 1.
  const projected = [...store.project.surfaces].sort((a, b) => b.z - a.z).map((s) => s.name);
  // O que a lista mostra, lido do DOM.
  const rows = [...document.querySelectorAll('li')]
    .map((li) => ({ badge: li.querySelector('span'), label: li.querySelector('button') }))
    .filter((r) => r.badge && r.label && /^\d+$/.test(r.badge.textContent.trim()))
    .map((r) => ({ number: Number(r.badge.textContent.trim()), name: r.label.textContent.trim() }));
  return { projected, rows };
});
const listOk = numbering.rows.length === numbering.projected.length
  && numbering.rows.every((row, i) => row.number === i + 1 && row.name === numbering.projected[i]);
check('AC-62: o número da lista é o número que o projetor desenha', listOk,
  `lista=${numbering.rows.map((r) => `${r.number}:${r.name}`).join(' ')} | projetado=${numbering.projected.join(' ')}`);

// A pasta guardada entre sessões depende de IndexedDB funcionar numa página
// `file://`, que é uma origem opaca — vale provar no artefato construído, e não
// no laptop de quem escreveu. Um handle de verdade não cabe aqui: ele só sai de
// um diálogo do sistema. O que se prova é a camada de baixo.
const idb = await page.evaluate(async () => {
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('map-engine', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('handles');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put({ name: 'palco' }, 'project-folder');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return await new Promise((resolve) => {
      const get = db.transaction('handles').objectStore('handles').get('project-folder');
      get.onsuccess = () => resolve(get.result?.name ?? null);
      get.onerror = () => resolve(null);
    });
  } catch (e) {
    return `erro: ${e}`;
  }
});
check('AC-56: file:// guarda e devolve o handle da pasta', idb === 'palco', `leu=${idb}`);

check('AC-14: console sem erros', consoleErrors.length === 0, consoleErrors.join(' | '));

await browser.close();
console.log(failures.length ? `\n${failures.length} falha(s)` : '\ntudo passou');
process.exit(failures.length ? 1 : 0);
