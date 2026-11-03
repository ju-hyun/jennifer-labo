/**
 * 応答時間パーセンタイル分布分析 (Percentile Distribution / PD)
 *
 * エントリポイント。状態管理と DOM イベントの束ねのみを担当し、
 * 通信は api.js、統計は stats.js、描画は chart.js / panel.js に委譲する。
 */

import {
  fetchDomains, fetchInstances, fetchBusinesses,
  collectTransactions, buildChunks, ApiError, generateMockTransactions
} from './api.js';
import {
  TxStore, filterIndices, sortedResponseTimes, summarize,
  buildHistogram, buildCdfPoints, appRanking, applyHistogramEdges
} from './stats.js';
import {
  renderHistogram, renderCdf, renderRanking, PERCENTILE_COLORS, fmt, fmtInt
} from './chart.js';
import { openPanel, closePanel, isPanelOpen } from './panel.js';

const PD_CFG = window.PD_CONFIG || {};

/* ------------------------------------------------------------------ */
/* 状態                                                                */
/* ------------------------------------------------------------------ */

const state = {
  domainTree: [],
  selectedPath: [],          // [{ id, name, type }]
  targetType: 'instance',
  instanceId: '',
  businessId: '',
  store: new TxStore(),
  indices: null,
  sorted: null,
  summary: null,
  histogram: null,
  collecting: false,
  abortController: null,
  lastRange: null,
  drilldownApp: null,
  snapshot: null      // 比較モード用の前回照会スナップショット
};

const charts = { histogram: null, cdf: null, ranking: null };

const $ = (id) => document.getElementById(id);

const el = {
  breadcrumb: $('breadcrumbContainer'),
  typeInstance: $('typeInstance'),
  typeBusiness: $('typeBusiness'),
  instanceArea: $('instanceFilterArea'),
  businessArea: $('businessFilterArea'),
  instanceSelect: $('instanceSelect'),
  businessSelect: $('businessSelect'),
  presetGroup: $('presetGroup'),
  startInput: $('startInput'),
  endInput: $('endInput'),
  chunkBadge: $('chunkBadge'),
  fetchBtn: $('fetchBtn'),
  abortBtn: $('abortBtn'),
  progressCard: $('progressCard'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  notice: $('noticeBar'),
  histogramTitle: $('histogramTitle'),
  histogramCanvas: $('histogramCanvas'),
  cdfCanvas: $('cdfCanvas'),
  rankingCanvas: $('rankingCanvas'),
  errorModeSelect: $('errorModeSelect'),
  appKeyword: $('appKeyword'),
  binModeSelect: $('binModeSelect'),
  manualBinArea: $('manualBinArea'),
  binWidthInput: $('binWidthInput'),
  xMaxInput: $('xMaxInput'),
  logYToggle: $('logYToggle'),
  tailZoomToggle: $('tailZoomToggle'),
  compareToggle: $('compareToggle'),
  pctToggles: $('pctToggles'),
  resetFilterBtn: $('resetFilterBtn'),
  csvBtn: $('csvBtn')
};

/* ------------------------------------------------------------------ */
/* ユーティリティ                                                      */
/* ------------------------------------------------------------------ */

function showNotice(message, level = 'info') {
  if (!message) {
    el.notice.classList.add('hidden');
    return;
  }
  el.notice.textContent = message;
  el.notice.className = `notice notice-${level}`;
}

function toLocalInput(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function rangeLabel(range) {
  const p = (n) => String(n).padStart(2, '0');
  const t = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${t(range.start)}–${t(range.end)}`;
}

function readRange() {
  const start = el.startInput.value ? new Date(el.startInput.value) : null;
  const end = el.endInput.value ? new Date(el.endInput.value) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return null;
  return { start, end };
}

function setPreset(minutes) {
  const end = new Date();
  end.setMilliseconds(0);
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  el.startInput.value = toLocalInput(start);
  el.endInput.value = toLocalInput(end);
  updateChunkBadge();
}

function updateChunkBadge() {
  const range = readRange();
  if (!range) {
    el.chunkBadge.textContent = '期間が不正です';
    el.chunkBadge.classList.add('is-warn');
    return;
  }
  const count = buildChunks(range.start, range.end).length;
  el.chunkBadge.textContent = `${count} チャンク`;
  // 1時間(60チャンク)を超える指定は逐次照会の待ち時間が大きくなるため警告する
  el.chunkBadge.classList.toggle('is-warn', count > 60);
  el.chunkBadge.title =
    count > 60
      ? `OpenAPI仕様(付録5.9.4.5)により1回の照会は最大1分です。${count} 回の逐次照会になります。`
      : 'OpenAPI仕様(付録5.9.4.5)により1回の照会は最大1分です。';
}

/* ------------------------------------------------------------------ */
/* ドメイン階層セレクタ (PTA から移植)                                  */
/* ------------------------------------------------------------------ */

function buildDomainTree(flatDomains) {
  const tree = [];
  flatDomains.forEach((domain) => {
    let level = tree;
    const hierarchy = domain.groupHierarchy?.length ? domain.groupHierarchy : ['未分類ドメイン'];

    hierarchy.forEach((groupName) => {
      let node = level.find((n) => n.type === 'group' && n.name === groupName);
      if (!node) {
        node = { type: 'group', name: groupName, children: [] };
        level.push(node);
      }
      level = node.children;
    });

    level.push({
      type: 'domain',
      id: String(domain.domainId),
      name: domain.name,
      children: []
    });
  });
  return tree;
}

function findFirstDomain(nodes, path = []) {
  for (const node of nodes) {
    const nextPath = [...path, node];
    if (node.type === 'domain') return { node, path: nextPath };
    const found = findFirstDomain(node.children, nextPath);
    if (found) return found;
  }
  return null;
}

function closePopovers() {
  document.querySelectorAll('.breadcrumb-popover').forEach((p) => p.remove());
}

function renderBreadcrumb() {
  el.breadcrumb.innerHTML = '';
  closePopovers();

  state.selectedPath.forEach((node, level) => {
    if (level > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      el.breadcrumb.appendChild(sep);
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className = `breadcrumb-item ${node.type === 'domain' ? 'is-domain' : ''}`;
    item.textContent = node.name;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const siblings = level === 0 ? state.domainTree : state.selectedPath[level - 1].children;
      openPopover(item, siblings, level);
    });
    el.breadcrumb.appendChild(item);
  });
}

function openPopover(anchor, items, level) {
  const alreadyOpen = document.querySelector('.breadcrumb-popover');
  closePopovers();
  if (alreadyOpen && alreadyOpen.dataset.level === String(level)) return;

  const pop = document.createElement('div');
  pop.className = 'breadcrumb-popover';
  pop.dataset.level = String(level);

  items.forEach((node) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `popover-item ${node.type === 'domain' ? 'is-domain' : ''}`;
    btn.textContent = node.name;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNode([...state.selectedPath.slice(0, level), node]);
      closePopovers();
    });
    pop.appendChild(btn);
  });

  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${rect.left + window.scrollX}px`;
  pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  document.body.appendChild(pop);
}

function selectNode(path) {
  // グループが選ばれた場合は配下の最初のドメインまで降りる
  let finalPath = path;
  const last = path[path.length - 1];
  if (last.type === 'group') {
    const found = findFirstDomain(last.children, path);
    if (found) finalPath = found.path;
  }
  state.selectedPath = finalPath;
  renderBreadcrumb();

  const domainId = getDomainId();
  if (domainId) loadTargets(domainId);
}

function getDomainId() {
  const last = state.selectedPath[state.selectedPath.length - 1];
  return last && last.type === 'domain' ? last.id : null;
}

/* ------------------------------------------------------------------ */
/* 対象リスト                                                          */
/* ------------------------------------------------------------------ */

async function loadDomains() {
  try {
    const flat = await fetchDomains();
    state.domainTree = buildDomainTree(flat);
  } catch (err) {
    console.error('Failed to load domains:', err);
    showNotice('ドメイン一覧の取得に失敗しました。モックデータで表示しています。', 'warn');
    state.domainTree = buildDomainTree([
      { domainId: 1000, name: 'REALTIME, ANALYSIS', groupHierarchy: ['JENNIFER DEMO', 'MSA'] },
      { domainId: 1004, name: 'Total', groupHierarchy: ['Total'] }
    ]);
  }

  const first = findFirstDomain(state.domainTree);
  if (first) {
    state.selectedPath = first.path;
    renderBreadcrumb();
    await loadTargets(getDomainId());
  }
}

async function loadTargets(domainId) {
  const [instances, businesses] = await Promise.all([
    fetchInstances(domainId).catch(() => []),
    fetchBusinesses(domainId).catch(() => [])
  ]);

  el.instanceSelect.innerHTML = '<option value="">全体インスタンス</option>';
  instances.forEach((inst) => {
    const opt = document.createElement('option');
    opt.value = inst.instanceId;
    opt.textContent = inst.name;
    el.instanceSelect.appendChild(opt);
  });

  el.businessSelect.innerHTML = '<option value="">全体ビジネス</option>';
  businesses.forEach((biz) => {
    const opt = document.createElement('option');
    opt.value = biz.businessId;
    const depth = (String(biz.businessIndex ?? '').match(/\./g) || []).length;
    opt.textContent = '  '.repeat(depth) + biz.name;
    el.businessSelect.appendChild(opt);
  });

  state.instanceId = '';
  state.businessId = '';
}

/* ------------------------------------------------------------------ */
/* 収集                                                                */
/* ------------------------------------------------------------------ */

async function runCollection() {
  if (state.collecting) return;

  const domainId = getDomainId();
  if (!domainId) {
    showNotice('ドメインを選択してください。', 'warn');
    return;
  }

  const range = readRange();
  if (!range) {
    showNotice('開始時刻と終了時刻を正しく指定してください (終了 > 開始)。', 'warn');
    return;
  }

  // 直前の照会結果を比較用スナップショットとして退避する (設計書 §6-4)
  if (state.summary?.count > 0 && state.lastRange) {
    state.snapshot = {
      sorted: state.sorted,
      summary: state.summary,
      label: rangeLabel(state.lastRange)
    };
    el.compareToggle.disabled = false;
  }

  state.collecting = true;
  state.abortController = new AbortController();
  state.store = new TxStore();
  state.drilldownApp = null;
  state.lastRange = range;

  el.fetchBtn.disabled = true;
  el.abortBtn.classList.remove('hidden');
  el.progressCard.classList.remove('hidden');
  el.progressBar.style.width = '0%';
  showNotice('');

  // インスタンス選択時のみ API 側で絞り込む。ビジネスは API に該当パラメータが無いため
  // 収集後にクライアント側でフィルタする (設計書 §3.5 / 制約 C3)。
  const instanceIds =
    state.targetType === 'instance' && state.instanceId ? [state.instanceId] : [];

  const totalChunks = buildChunks(range.start, range.end).length;
  let lastPaint = 0;

  const updateProgress = (info) => {
    const pct = totalChunks ? (info.done / totalChunks) * 100 : 0;
    el.progressBar.style.width = `${pct.toFixed(1)}%`;
    el.progressText.textContent =
      `データロード中... (${info.done}/${totalChunks} チャンク · ${fmtInt(info.total)} 件)`;
  };

  try {
    const result = await collectTransactions({
      domainId,
      instanceIds,
      startDate: range.start,
      endDate: range.end,
      signal: state.abortController.signal,
      onChunk: (rows) => {
        state.store.push(rows);
        // 10チャンクごと、または1秒ごとに中間描画して進行を可視化する
        const now = performance.now();
        if (now - lastPaint > 1000) {
          lastPaint = now;
          recompute({ quiet: true });
        }
      },
      onProgress: updateProgress
    });

    // 全チャンクが失敗した = サーバに到達できていない。PTA と同様にモックへ退避する。
    if (result.chunks > 0 && result.failed === result.chunks) {
      state.store.push(generateMockTransactions(range.start, range.end));
      showNotice(
        'JENNIFERサーバに接続できませんでした。以下はモックデータによる表示です。実データではありません。',
        'error'
      );
      return;
    }

    const messages = [];
    if (result.aborted) messages.push('収集を中断しました。');
    if (result.limitReached) messages.push('標本上限に到達したため収集を打ち切りました。期間を狭めてください。');
    if (result.failed > 0) messages.push(`${result.failed}/${result.chunks} チャンクの取得に失敗しスキップしました。`);
    if (result.total === 0 && !result.aborted) {
      messages.push('該当期間にトランザクションがありませんでした。');
    }
    showNotice(messages.join(' '), result.failed || result.limitReached ? 'warn' : 'info');
  } catch (err) {
    console.error('Collection failed:', err);
    const reason =
      err instanceof ApiError && err.status === 401
        ? '認証に失敗しました (401)。サーバ側のAPIトークン設定をご確認ください。'
        : `収集中にエラーが発生しました: ${err.message}`;
    // 画面の挙動を確認できるよう、失敗時もモックで描画する (PTA と同じ方針)
    state.store = new TxStore();
    state.store.push(generateMockTransactions(range.start, range.end));
    showNotice(`${reason} 以下はモックデータによる表示で、実データではありません。`, 'error');
  } finally {
    state.collecting = false;
    state.abortController = null;
    el.fetchBtn.disabled = false;
    el.abortBtn.classList.add('hidden');
    el.progressCard.classList.add('hidden');
    recompute();
  }
}

/* ------------------------------------------------------------------ */
/* 再計算・描画                                                        */
/* ------------------------------------------------------------------ */

function currentFilters() {
  return {
    businessId: state.targetType === 'business' ? state.businessId : '',
    errorMode: el.errorModeSelect.value,
    // ドリルダウン中はアプリ名の完全一致、それ以外は入力キーワードの部分一致
    appKeyword: state.drilldownApp === null ? el.appKeyword.value : '',
    appExact: state.drilldownApp === null ? undefined : state.drilldownApp
  };
}

function activePercentiles() {
  return [...el.pctToggles.querySelectorAll('input:checked')].map((i) => Number(i.value));
}

function recompute({ quiet = false } = {}) {
  const store = state.store;
  state.indices = filterIndices(store, currentFilters());
  state.sorted = sortedResponseTimes(store, state.indices);
  state.summary = summarize(store, state.indices, state.sorted);

  const binMode = el.binModeSelect.value;
  state.histogram = buildHistogram(state.sorted, {
    mode: binMode,
    binWidth: Number(el.binWidthInput.value) || undefined,
    xMax: Number(el.xMaxInput.value) || undefined
  });

  renderSummary();
  renderCharts();

  if (!quiet && state.drilldownApp) {
    showNotice(`「${state.drilldownApp}」に絞り込み中です。「解除」で全件に戻せます。`, 'info');
  }
}

function renderSummary() {
  const s = state.summary;
  const ms = (v) => (Number.isFinite(v) ? `${fmt(v, 1)} ms` : '-');

  $('cardCount').textContent = fmtInt(s.count);
  $('cardMean').textContent = ms(s.mean);
  $('cardP50').textContent = ms(s.percentiles[50]);
  $('cardP90').textContent = ms(s.percentiles[90]);
  $('cardP95').textContent = ms(s.percentiles[95]);
  $('cardP99').textContent = ms(s.percentiles[99]);
  $('cardMax').textContent = ms(s.max);
  $('cardErrRate').textContent = Number.isFinite(s.errorRate) ? `${fmt(s.errorRate)} %` : '-';

  renderDeltas();

  const title = `応答時間分布 (サンプル数: ${fmtInt(s.count)} 件)`;
  el.histogramTitle.textContent =
    s.count > 0 && s.count < 1000 ? `${title} — 標本不足` : title;
  el.histogramTitle.classList.toggle('is-low-sample', s.count > 0 && s.count < 1000);
}

/** 比較モード時、前回照会との増減をサマリカードに併記する */
function renderDeltas() {
  const active = isCompareActive();
  const prev = state.snapshot?.summary;
  const cur = state.summary;

  const pairs = [
    ['cardCount', cur.count, prev?.count, 0, false],
    ['cardMean', cur.mean, prev?.mean, 1, true],
    ['cardP50', cur.percentiles[50], prev?.percentiles[50], 1, true],
    ['cardP90', cur.percentiles[90], prev?.percentiles[90], 1, true],
    ['cardP95', cur.percentiles[95], prev?.percentiles[95], 1, true],
    ['cardP99', cur.percentiles[99], prev?.percentiles[99], 1, true],
    ['cardMax', cur.max, prev?.max, 1, true],
    ['cardErrRate', cur.errorRate, prev?.errorRate, 2, true]
  ];

  pairs.forEach(([id, now, before, digits, isMs]) => {
    const node = $(`${id}Delta`);
    if (!node) return;
    if (!active || !Number.isFinite(now) || !Number.isFinite(before)) {
      node.textContent = '';
      node.className = 'summary-delta';
      return;
    }
    const diff = now - before;
    const sign = diff > 0 ? '+' : '';
    node.textContent = `${sign}${fmt(diff, digits)}${isMs ? '' : ''} vs ${state.snapshot.label}`;
    node.className = `summary-delta ${diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : 'is-flat'}`;
  });
}

function isCompareActive() {
  return !!(state.snapshot && el.compareToggle.checked && !el.compareToggle.disabled);
}

function renderCharts() {
  const s = state.summary;

  const markers = activePercentiles()
    .map((p) => ({
      p,
      label: `P${p}`,
      value: s.percentiles[p],
      color: PERCENTILE_COLORS[p] || '#334155',
      dashed: p < 90
    }))
    .filter((m) => Number.isFinite(m.value))
    .sort((a, b) => a.value - b.value);

  // 比較モードでは前回データを「今回と同じビン境界」に当てはめて重ねる
  const comparison = isCompareActive()
    ? applyHistogramEdges(state.snapshot.sorted, state.histogram)
    : null;

  charts.histogram = renderHistogram(
    el.histogramCanvas, charts.histogram, state.histogram, markers,
    {
      logScaleY: el.logYToggle.checked,
      onBarClick: handleBarClick,
      comparison,
      comparisonLabel: `前回 (${state.snapshot?.label ?? ''})`
    }
  );

  charts.cdf = renderCdf(
    el.cdfCanvas, charts.cdf, buildCdfPoints(state.sorted),
    { tailZoom: el.tailZoomToggle.checked }
  );

  charts.ranking = renderRanking(
    el.rankingCanvas, charts.ranking, appRanking(state.store, state.indices),
    { onRowClick: (row) => { state.drilldownApp = row.name; recompute(); } }
  );
}

/* ------------------------------------------------------------------ */
/* 詳細パネル                                                          */
/* ------------------------------------------------------------------ */

function handleBarClick(binIndex) {
  const h = state.histogram;
  const isOverflow = h.overflowCount > 0 && binIndex >= h.counts.length;

  const lo = isOverflow ? h.xMax : h.edges[binIndex];
  const hi = isOverflow ? Infinity : h.edges[binIndex + 1];

  const rows = [];
  for (let i = 0; i < state.indices.length; i++) {
    const idx = state.indices[i];
    const rt = state.store.responseTime[idx];
    if (rt >= lo && (isOverflow ? true : rt < hi)) rows.push(state.store.row(idx));
  }
  rows.sort((a, b) => b.responseTime - a.responseTime);

  const total = state.summary.count || 1;
  const ratio = (rows.length / total) * 100;

  openPanel({
    title: isOverflow ? `${fmtInt(lo)}ms 以上` : `${fmtInt(lo)} 〜 ${fmtInt(hi)} ms`,
    subtitle: `${fmtInt(rows.length)} 件 (${fmt(ratio)}%)`,
    rows,
    totalCount: rows.length
  });
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

function exportCsv() {
  if (!state.summary || state.summary.count === 0) {
    showNotice('エクスポートするデータがありません。', 'warn');
    return;
  }

  const h = state.histogram;
  const lines = ['# パーセンタイル要約', 'metric,value_ms'];
  lines.push(`count,${state.summary.count}`);
  lines.push(`mean,${state.summary.mean.toFixed(3)}`);
  lines.push(`min,${state.summary.min.toFixed(3)}`);
  lines.push(`max,${state.summary.max.toFixed(3)}`);
  lines.push(`stdev,${state.summary.stdev.toFixed(3)}`);
  Object.entries(state.summary.percentiles).forEach(([p, v]) => {
    lines.push(`P${p},${v.toFixed(3)}`);
  });

  lines.push('', '# ヒストグラム', 'bin_from_ms,bin_to_ms,count,ratio_percent');
  const total = h.total || 1;
  h.counts.forEach((c, i) => {
    lines.push(`${h.edges[i]},${h.edges[i + 1]},${c},${((c / total) * 100).toFixed(4)}`);
  });
  if (h.overflowCount > 0) {
    lines.push(`${h.xMax},,${h.overflowCount},${((h.overflowCount / total) * 100).toFixed(4)}`);
  }

  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = state.lastRange
    ? `${toLocalInput(state.lastRange.start)}_${toLocalInput(state.lastRange.end)}`.replace(/[:T-]/g, '')
    : 'export';
  a.href = url;
  a.download = `percentile_distribution_${stamp}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* ヘルプ                                                              */
/* ------------------------------------------------------------------ */

let helpWindow = null;

function openHelp(anchor) {
  const url = `./help.html#${anchor || ''}`;
  if (helpWindow && !helpWindow.closed) {
    helpWindow.location.hash = anchor || '';
    helpWindow.focus();
    return;
  }
  helpWindow = window.open(url, 'pdHelp', 'width=880,height=900,scrollbars=yes');
}

/* ------------------------------------------------------------------ */
/* イベント束ね                                                        */
/* ------------------------------------------------------------------ */

function bindEvents() {
  el.presetGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset-btn');
    if (!btn) return;
    el.presetGroup.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    setPreset(Number(btn.dataset.minutes));
  });

  [el.startInput, el.endInput].forEach((input) => {
    input.addEventListener('change', () => {
      el.presetGroup.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('is-active'));
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

// 開発時のみ、ブラウザコンソールから状態を覗けるようにする
if (import.meta.env?.DEV) {
  window.__pd = { state, charts };
}

async function init() {
  if (!PD_CFG.BASE_URL && !PD_CFG.API_DOMAIN) {
    console.warn('PD_CONFIG が未設定です。public/pd/config.js を確認してください。');
  }

  setPreset(15);
  bindEvents();
  recompute({ quiet: true });
  await loadDomains();
}

init();
