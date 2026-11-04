/**
 * 収集済みデータの絞り込み・再計算と、サマリ/チャート/詳細パネルの描画
 */
import { filterIndices, sortedResponseTimes, summarize, buildHistogram, buildCdfPoints, appRanking, applyHistogramEdges } from './stats.js';
import { renderHistogram, renderCdf, renderRanking, PERCENTILE_COLORS, fmt, fmtInt } from './chart.js';
import { openPanel, MAX_ROWS as PANEL_MAX_ROWS } from './panel.js';
import { charts, state } from './state.js';
import { $, el } from './dom.js';
import { showNotice } from './notice.js';

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

export function recompute({ quiet = false } = {}) {
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

export function renderSummary() {
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
    ['cardCount', cur.count, prev?.count, 0, ' 件'],
    ['cardMean', cur.mean, prev?.mean, 1, ' ms'],
    ['cardP50', cur.percentiles[50], prev?.percentiles[50], 1, ' ms'],
    ['cardP90', cur.percentiles[90], prev?.percentiles[90], 1, ' ms'],
    ['cardP95', cur.percentiles[95], prev?.percentiles[95], 1, ' ms'],
    ['cardP99', cur.percentiles[99], prev?.percentiles[99], 1, ' ms'],
    ['cardMax', cur.max, prev?.max, 1, ' ms'],
    ['cardErrRate', cur.errorRate, prev?.errorRate, 2, ' pt'] // パーセンテージポイント
  ];

  pairs.forEach(([id, now, before, digits, unit]) => {
    const node = $(`${id}Delta`);
    if (!node) return;
    if (!active || !Number.isFinite(now) || !Number.isFinite(before)) {
      node.textContent = '';
      node.className = 'summary-delta';
      return;
    }
    const diff = now - before;
    const sign = diff > 0 ? '+' : '';
    node.textContent = `${sign}${fmt(diff, digits)}${unit} vs ${state.snapshot.label}`;
    node.className = `summary-delta ${diff > 0 ? 'is-up' : diff < 0 ? 'is-down' : 'is-flat'}`;
  });
}

function isCompareActive() {
  return !!(state.snapshot && el.compareToggle.checked && !el.compareToggle.disabled);
}

export function renderCharts() {
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

  // 区間内の行インデックスだけを集め、応答時間の降順に並べて表示分(上位)だけを行オブジェクトに復元する。
  // (数十万件の区間でも全件をオブジェクト化しない)
  const rt = state.store.responseTime;
  const inBin = [];
  for (let i = 0; i < state.indices.length; i++) {
    const idx = state.indices[i];
    const v = rt[idx];
    if (v >= lo && (isOverflow ? true : v < hi)) inBin.push(idx);
  }
  inBin.sort((a, b) => rt[b] - rt[a]);
  const rows = inBin.slice(0, PANEL_MAX_ROWS).map((idx) => state.store.row(idx));

  const total = state.summary.count || 1;
  const ratio = (inBin.length / total) * 100;

  openPanel({
    title: isOverflow ? `${fmtInt(lo)}ms 以上` : `${fmtInt(lo)} 〜 ${fmtInt(hi)} ms`,
    subtitle: `${fmtInt(inBin.length)} 件 (${fmt(ratio)}%)`,
    rows,
    totalCount: inBin.length
  });
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */
