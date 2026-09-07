<script lang="ts">
  import Stage from './stage/Stage.svelte';
  import TopBar from './TopBar.svelte';
  import Toolbar from './stage/Toolbar.svelte';
  import ProjectPanel from './panels/ProjectPanel.svelte';
  import SurfaceList from './panels/SurfaceList.svelte';
  import Inspector from './panels/Inspector.svelte';
  import SourcePanel from './panels/SourcePanel.svelte';
  import AboutPage from './pages/AboutPage.svelte';
  import DocsPage from './pages/DocsPage.svelte';
  import { store, tools, session, duplicateSelected, flash, getEngine, selected, framePixelStep } from './state.svelte.ts';
  import { scheduleSave, localProject, hasFileSystemAccess, restoreFolder, setMemoryLabel } from './platform/project-folder.ts';
  import { initTheme } from './platform/theme.svelte.ts';
  import { initLocale, i18n, t } from './i18n/index.svelte.ts';

  initTheme();
  initLocale();

  // DECISION: recover browser storage on every startup. A permitted folder
  // takes precedence when restored below; API support alone is not a folder.
  const saved = localProject();
  if (saved) {
    try { store.load(saved); } catch { /* Invalid autosave: start empty. */ }
  }

  // O rótulo de "onde foi salvo" é cópia, então quem tem o catálogo é quem o
  // define — e ele acompanha a troca de idioma.
  $effect(() => {
    setMemoryLabel(t('project.inBrowserMemory'));
    void i18n.locale;
  });

  // Autosave a cada mudança. Meia hora de alinhamento não pode depender de
  // alguém lembrar de Ctrl+S em cima de uma escada.
  // Derived identity filters notifications that only change the view.
  const project = $derived($store.project);
  let firstRun = true;
  $effect(() => {
    void project;
    if (firstRun) { firstRun = false; return; }
    scheduleSave(store, (where) => {
      session.folderName = where;
      session.savedAt = Date.now();
      setTimeout(() => { session.savedAt = 0; }, 2200);
    }, flash);
  });

  // Volta para a pasta da sessão anterior. Roda uma vez, antes de qualquer
  // edição: um handle recuperado nunca pode passar por cima de trabalho vivo.
  // Se a permissão não sobreviveu, o nome vai para `pendingFolder` e o painel
  // oferece o clique que pode pedi-la — pedir aqui seria rejeitado.
  $effect(() => {
    if (!hasFileSystemAccess) return;
    void restoreFolder().then((restored) => {
      if (!restored) return;
      if (restored.state === 'prompt') {
        session.pendingFolder = restored.name;
        return;
      }
      if (restored.json) {
        try { store.load(restored.json); } catch { flash(t('warn.folderFailed')); return; }
      }
      session.hasFolder = true;
      session.folderName = restored.name;
      flash(t('project.reopened', { name: restored.name }));
    }).catch(() => { /* sem memória de pasta, segue como antes */ });
  });

  $effect(() => {
    if (!hasFileSystemAccess) {
      flash(t('warn.noFileSystemAccess'));
    }
  });

  $effect(() => {
    const engine = getEngine();
    if (!engine) return;
    // Nada a ver, nada a desenhar: o loop para enquanto uma página de texto
    // estiver por cima do editor.
    if (session.page === 'editor') engine.start();
    else engine.stop();
  });

  /** O acerto de 1 px é o que separa "quase encaixado" de encaixado. As setas
   *  movem o canto selecionado, ou a superfície toda quando não há canto. */
  function onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

    if (e.key === 'Control') tools.snapOff = true;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? store.redo() : store.undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); store.redo(); return; }

    const s = selected();
    if (mod && e.key.toLowerCase() === 'd' && s) { e.preventDefault(); duplicateSelected(); return; }

    if (e.key === 'Escape') {
      // Fora do editor, Esc é o caminho de volta.
      if (session.page !== 'editor') { session.page = 'editor'; return; }
      tools.pendingPolygon = [];
      tools.tool = 'select';
      store.setView({ selectedCorner: null, selectedWarpPoint: null });
      return;
    }
    if (e.key.toLowerCase() === 'h') { store.setView({ uiHidden: !$store.view.uiHidden }); return; }
    if (e.key.toLowerCase() === 'x') { store.setView({ xray: !$store.view.xray }); return; }
    // Ctrl+A escolhe tudo que está visível: o atalho que ninguém procura no
    // manual, e a forma mais rápida de mover uma parede inteira de uma vez.
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      store.setSelection($store.project.surfaces.filter((x) => x.visible).map((x) => x.id));
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && s) {
      for (const id of [...$store.view.selectedIds]) store.removeSurface(id);
      return;
    }

    const step = e.shiftKey ? 10 : 1;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (d && s) {
      e.preventDefault();
      const warpPoint = $store.view.selectedWarpPoint;
      const corner = $store.view.selectedCorner;
      if (warpPoint !== null && s.warp) {
        // O ponto de malha vive em 0..1 dentro do frame: o passo tem que ser
        // convertido, senão "1 px" significa coisas diferentes em cada tamanho.
        const step = framePixelStep(s);
        store.nudgeWarpPoint(s.id, warpPoint, d[0] * step.x, d[1] * step.y, tools.warpFalloff);
      } else if (corner !== null) {
        store.nudgeCorner(s.id, corner, d[0], d[1]);
      } else {
        // Sem canto nem ponto escolhido, as setas movem a seleção inteira —
        // o mesmo que o arrasto faz. Uma só selecionada é o caso de sempre.
        store.moveSelection(d[0], d[1]);
      }
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'Control') tools.snapOff = false;
    if (e.key.startsWith('Arrow')) store.endGesture();
  }
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<div class="flex h-full flex-col bg-base-100">
  {#if !$store.view.uiHidden}
    <TopBar />
    {#if session.page === 'editor'}
      <Toolbar />
    {/if}
  {/if}

  <!-- Em tela estreita o painel desce para baixo da área de trabalho em vez de
       espremer os dois: alinhar precisa de largura, configurar não. -->
  <!-- O guia cobre o editor em vez de substituí-lo: desmontar a Stage destruiria
       o contexto WebGL e faria a captura de tela pedir permissão de novo ao voltar. -->
  <div class="relative flex min-h-0 flex-1 flex-col lg:flex-row">
    {#if session.page === 'docs'}
      <DocsPage />
    {:else if session.page === 'about'}
      <AboutPage />
    {/if}
    <Stage />
    {#if !$store.view.uiHidden}
      <aside class="max-h-[45vh] w-full shrink-0 overflow-y-auto border-t border-base-300 bg-base-100 lg:max-h-none lg:w-[320px] lg:border-t-0 lg:border-l">
        <ProjectPanel />
        <SurfaceList />
        <Inspector />
        <SourcePanel />
      </aside>
    {/if}
  </div>
</div>

{#if session.status && !$store.view.uiHidden}
  <div class="toast toast-start z-50">
    <div class="alert alert-info max-w-lg text-sm shadow-lg">
      <span>{session.status}</span>
    </div>
  </div>
{/if}
