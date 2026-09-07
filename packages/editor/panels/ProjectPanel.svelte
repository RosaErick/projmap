<script lang="ts">
  import { store, session, flash, getEngine } from '../state.svelte.ts';
  import { openFolder, save, downloadProject, grantFolder, hasFileSystemAccess, invalidateUrls, resolveUrl, FolderError } from '../platform/project-folder.ts';
  import { openOutput, listScreens, type OutputScreen, type OutputWarning } from '../../output/output.ts';
  import { t, type MessageKey } from '../i18n/index.svelte.ts';

  // As telas são enumeradas na montagem, e não no clique: pedir a lista dentro
  // do handler gastaria a ativação de usuário que window.open e
  // requestFullscreen ainda precisam.
  let screens = $state<OutputScreen[]>([]);
  let screenIndex = $state(0);
  let output = $state<{ close(): void } | null>(null);

  const servedOverHttp = location.protocol.startsWith('http');

  $effect(() => {
    void listScreens().then((list) => {
      screens = list;
      const external = list.findIndex((s) => !s.isInternal);
      if (list.length > 1) screenIndex = external >= 0 ? external : 1;
    });
  });

  function screenLabel(s: OutputScreen, i: number): string {
    return `${i + 1}. ${s.label || t(s.isInternal ? 'project.screenInternal' : 'project.screenExternal')} — ${s.width}×${s.height}`;
  }

  /** A saída tem que ser a resolução nativa do projetor: escalonar duas vezes
   *  borra exatamente o que foi alinhado com precisão de pixel. */
  function matchScreen(): void {
    const s = screens[screenIndex];
    if (!s) return;
    store.setOutputSize(Math.round(s.width * s.devicePixelRatio), Math.round(s.height * s.devicePixelRatio));
    flash(t('project.resolutionSet', { width: store.project.output.width, height: store.project.output.height }));
  }

  async function onOpenFolder(): Promise<void> {
    try {
      const json = await openFolder();
      invalidateUrls();
      if (json) store.load(json);
      session.hasFolder = true;
      session.folderName = t('project.folderOpen');
      flash(json ? t('project.loaded') : t('project.emptyFolder'));
    } catch (e) {
      // Cancelar o seletor não é erro: só um "deixa pra lá".
      if ((e as DOMException | null)?.name === 'AbortError') return;
      flash(e instanceof FolderError ? t('warn.folderUnsupported') : t('warn.folderFailed'));
    }
  }

  /** Reabre a pasta da sessão anterior. Precisa estar dentro do clique: é o
   *  gesto do usuário que dá ao app o direito de pedir a permissão. */
  async function onReopen(): Promise<void> {
    try {
      const restored = await grantFolder();
      if (!restored) {
        // Negar é uma resposta legítima. O botão some porque insistir com ele a
        // cada abertura seria pior do que aceitar o não.
        session.pendingFolder = '';
        flash(t('warn.folderFailed'));
        return;
      }
      invalidateUrls();
      if (restored.json) store.load(restored.json);
      session.pendingFolder = '';
      session.hasFolder = true;
      session.folderName = restored.name;
      flash(restored.json ? t('project.loaded') : t('project.emptyFolder'));
    } catch {
      flash(t('warn.folderFailed'));
    }
  }

  /** Códigos da janela de saída viram frase aqui: quem abre a janela não escolhe
   *  as palavras que o operador lê. */
  const WARNINGS: Record<OutputWarning, MessageKey> = {
    'popup-blocked': 'warn.popupBlocked',
    'fullscreen-failed': 'warn.fullscreenFailed',
    'screen-not-found': 'warn.screenNotFound',
    'no-window-management': 'warn.noWindowManagement',
  };

  function onOutput(): void {
    if (output) { output.close(); return; }
    const pool = getEngine()?.pool;
    const screen = screens[screenIndex];
    output = openOutput(store, {
      ...(screens[screenIndex] ? { screen: screens[screenIndex] } : {}),
      // Um decode, um pedido de permissão de captura: a saída pega emprestadas
      // as fontes do editor em vez de montar as suas.
      ...(pool ? { pool } : {}),
      resolveUrl,
      title: t('output.windowTitle'),
      onWarn: (code) => flash(t(WARNINGS[code])),
      onClose: () => {
        output = null;
        session.outputOpen = false;
        session.outputScreen = '';
      },
    });
    session.outputOpen = !!output;
    session.outputScreen = output && screen ? (screen.label || t('project.screenFallback', { number: screenIndex + 1 })) : '';
  }
</script>

<!-- Abrir pasta e casar resolução são trabalho de começo e de fim de montagem.
     Ficam recolhidos assim que existe uma pasta, para o painel não empurrar as
     superfícies para fora da tela durante o alinhamento, que é o trabalho real. -->
<details class="collapse-arrow collapse border-b border-base-300 rounded-none" open={!session.hasFolder}>
  <summary class="collapse-title min-h-0 px-4 py-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-base-content/45">
    {t('project.title')}
  </summary>
  <div class="collapse-content px-4 pb-4">
  <p class="text-[11px] leading-relaxed text-base-content/55">
    {t('project.blurb')}
  </p>

  <div class="mt-3 flex flex-wrap gap-2">
    {#if session.pendingFolder}
      <!-- Um clique em vez de navegar o diálogo do sistema: o handle da sessão
           anterior está guardado, só a permissão não sobreviveu. -->
      <button class="btn btn-xs btn-primary" onclick={onReopen}>
        {t('project.reopen', { name: session.pendingFolder })}
      </button>
    {/if}
    <button class="btn btn-xs" onclick={onOpenFolder} disabled={!hasFileSystemAccess}>
      {t('project.openFolder')}
    </button>
    <button class="btn btn-xs btn-ghost" onclick={() => save(store, (w) => flash(t('project.savedTo', { where: w })), flash)}>
      {t('project.saveNow')}
    </button>
    {#if !hasFileSystemAccess}
      <button class="btn btn-xs btn-ghost" onclick={() => downloadProject(store)}>{t('project.downloadJson')}</button>
    {/if}
  </div>
  {#if session.folderName}
    <p class="mt-2 text-[11px] text-base-content/50">{session.folderName}</p>
  {/if}

  <div class="divider my-4"></div>

  <h3 class="text-[10px] font-semibold uppercase tracking-[0.14em] text-base-content/45">{t('project.projector')}</h3>
  <p class="mt-1 text-[11px] leading-relaxed text-base-content/55">
    {t('project.resolutionBlurb')}
  </p>

  {#if screens.length > 1}
    <select class="select select-xs mt-3 w-full" bind:value={screenIndex}>
      {#each screens as s, i (i)}<option value={i}>{screenLabel(s, i)}</option>{/each}
    </select>
    <button class="btn btn-xs btn-block mt-2" onclick={matchScreen}>
      {t('project.matchScreen')}
    </button>
  {/if}

  <div class="mt-3 flex items-center gap-2">
    <input
      type="number"
      class="input input-xs w-full"
      aria-label={t('project.widthLabel')}
      value={$store.project.output.width}
      onchange={(e) => store.setOutputSize(+e.currentTarget.value, $store.project.output.height)}
    />
    <span class="text-base-content/40">×</span>
    <input
      type="number"
      class="input input-xs w-full"
      aria-label={t('project.heightLabel')}
      value={$store.project.output.height}
      onchange={(e) => store.setOutputSize($store.project.output.width, +e.currentTarget.value)}
    />
  </div>

  <button
    class="btn btn-sm btn-block mt-3"
    class:btn-primary={!output}
    class:btn-outline={!!output}
    onclick={onOutput}
  >
    {output ? t('project.closeOutput') : t('project.sendToProjector')}
  </button>

  {#if servedOverHttp}
    <a
      class="btn btn-xs btn-ghost btn-block mt-2 font-normal"
      href="./index.html"
      download="projection-mapping.html"
      title={t('project.downloadOfflineHint')}
    >
      {t('project.downloadOffline')}
    </a>
  {/if}
  </div>
</details>
