/**
 * DOM イベントの束ね
 */
import { closePanel, isPanelOpen } from './panel.js';
import { charts, state } from './state.js';
import { el } from './dom.js';
import { showNotice } from './notice.js';
import { setPreset, updateChunkBadge } from './range.js';
import { closePopovers } from './targets.js';
import { recompute, renderCharts, renderSummary } from './view.js';
import { runCollection } from './collect.js';
import { exportCsv } from './csv.js';
import { openHelp } from './help.js';

export function bindEvents() {
  el.presetGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    el.presetGroup.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    state.activePreset = Number(btn.dataset.minutes);
    setPreset(state.activePreset);
  });

  [el.startInput, el.endInput].forEach((input) => {
    input.addEventListener('change', () => {
      el.presetGroup.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('is-active'));
      state.activePreset = null;
      updateChunkBadge();
    });
  });

  el.fetchBtn.addEventListener('click', runCollection);
  el.abortBtn.addEventListener('click', () => state.abortController?.abort());

  el.typeInstance.addEventListener('change', () => switchTargetType('instance'));
  el.typeBusiness.addEventListener('change', () => switchTargetType('business'));

  el.instanceSelect.addEventListener('change', () => {
    state.instanceId = el.instanceSelect.value;
  });
  el.businessSelect.addEventListener('change', () => {
    state.businessId = el.businessSelect.value;
    recompute(); // ビジネスはクライアント側フィルタなので再照会不要
  });

  el.errorModeSelect.addEventListener('change', () => recompute());

  let keywordTimer = null;
  el.appKeyword.addEventListener('input', () => {
    state.drilldownApp = null;
    clearTimeout(keywordTimer);
    keywordTimer = setTimeout(() => recompute(), 200);
  });

  el.binModeSelect.addEventListener('change', () => {
    el.manualBinArea.classList.toggle('hidden', el.binModeSelect.value !== 'manual');
    recompute();
  });
  [el.binWidthInput, el.xMaxInput].forEach((i) =>
    i.addEventListener('change', () => recompute())
  );

  el.logYToggle.addEventListener('change', () => {
    charts.histogram?.destroy();
    charts.histogram = null;
    renderCharts();
  });
  el.tailZoomToggle.addEventListener('change', () => renderCharts());

  el.compareToggle.addEventListener('change', () => {
    // データセット数が変わるため、凡例込みで作り直す
    charts.histogram?.destroy();
    charts.histogram = null;
    renderSummary();
    renderCharts();
  });
  el.pctToggles.addEventListener('change', () => renderCharts());

  el.resetFilterBtn.addEventListener('click', () => {
    state.drilldownApp = null;
    el.appKeyword.value = '';
    el.errorModeSelect.value = 'all';
    showNotice('');
    recompute();
  });

  el.csvBtn.addEventListener('click', exportCsv);

  document.querySelectorAll('.help-btn-small').forEach((btn) => {
    btn.addEventListener('click', () => openHelp(btn.dataset.help));
  });

  document.addEventListener('click', () => closePopovers());

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isPanelOpen()) closePanel();
    else if (state.drilldownApp) {
      state.drilldownApp = null;
      recompute();
    }
    closePopovers();
  });
}

function switchTargetType(type) {
  state.targetType = type;
  el.instanceArea.classList.toggle('hidden', type !== 'instance');
  el.businessArea.classList.toggle('hidden', type !== 'business');
  recompute();
}

/* ------------------------------------------------------------------ */
/* 起動                                                                */
/* ------------------------------------------------------------------ */
