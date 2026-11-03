/**
 * Chart.js 構成層
 *
 * - メインヒストグラム (パーセンタイル垂直線オーバーレイ付き)
 * - パーセンタイル曲線 (CDF)
 * - アプリケーション別 P99 ランキング (横棒)
 */

import Chart from 'chart.js/auto';
import { cumulativeRatios } from './stats.js';

export const COLORS = {
  bar: '#4361ee',
  barHover: '#2f4bd8',
  overflow: '#f97316',
  overflowHover: '#ea580c',
  grid: '#e2e8f0',
  guide: '#cbd5e1',
  text: '#1e293b',
  textSub: '#64748b'
};

/** パーセンタイル基準線の色 */
export const PERCENTILE_COLORS = {
  50: '#64748b',
  75: '#0ea5e9',
  90: '#f59e0b',
  95: '#8b5cf6',
  99: '#ef4444',
  99.9: '#be123c'
};

const fmt = (v, digits = 2) =>
  Number.isFinite(v)
    ? v.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '-';
const fmtInt = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString('ja-JP') : '-');

/* ------------------------------------------------------------------ */
/* パーセンタイル オーバーレイ プラグイン                              */
/* ------------------------------------------------------------------ */

/**
 * ヒストグラム上にパーセンタイルの垂直線とラベルを描く。
 * annotation プラグインを使わず canvas に直接描画する (依存を増やさないため)。
 *
 * chart.options.plugins.percentileLines = {
 *   markers: [{ p: 99, value: 812.4, color: '#ef4444' }, ...],
 *   binWidth, xMax, edges
 * }
 */
export const percentileLinesPlugin = {
  id: 'percentileLines',
  afterDatasetsDraw(chart, _args, pluginOptions) {
    const markers = pluginOptions?.markers;
    if (!markers || !markers.length) return;

    const { ctx, chartArea } = chart;
    if (!chartArea || !chart.data?.labels?.length) return;

    const edges = pluginOptions.edges || [];
    if (edges.length < 2) return;

    // X はカテゴリ軸(ビン)なので、応答時間(ms)を「ビンの実数インデックス」へ変換してから
    // ピクセルに写す。カテゴリ b は幅の [b/N, (b+1)/N] を占めるため、
    // ビン内の位置比 ratio を足した (b + ratio) / N が描画位置になる。
    // N には表示中の全カテゴリ数(オーバーフロービンを含む)を用いる。
    const totalCategories = chart.data.labels.length;
    const areaLeft = chartArea.left;
    const areaWidth = chartArea.right - chartArea.left;

    const toPixel = (value) => {
      let fracIndex;
      if (value <= edges[0]) {
        fracIndex = 0;
      } else if (value >= edges[edges.length - 1]) {
        // 上限超過分はオーバーフロービンの領域に置く
        fracIndex = edges.length - 1;
      } else {
        fracIndex = edges.length - 1;
        for (let b = 0; b < edges.length - 1; b++) {
          const lo = edges[b];
          const hi = edges[b + 1];
          if (value >= lo && value < hi) {
            fracIndex = b + (hi === lo ? 0 : (value - lo) / (hi - lo));
            break;
          }
        }
      }
      return areaLeft + (fracIndex / totalCategories) * areaWidth;
    };

    const placed = [];
    ctx.save();

    markers.forEach((marker) => {
      if (!Number.isFinite(marker.value)) return;
      let x = toPixel(marker.value);
      x = Math.max(chartArea.left + 1, Math.min(chartArea.right - 1, x));

      ctx.beginPath();
      ctx.setLineDash(marker.dashed ? [5, 4] : []);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = marker.color;
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      // ラベルは縦書き。既に置いたラベルと近すぎる場合は右へずらす。
      let labelX = x;
      while (placed.some((px) => Math.abs(px - labelX) < 14)) labelX += 14;
      placed.push(labelX);

      const label = `${marker.label} = ${fmtInt(marker.value)}ms`;
      // translate/rotate は save/restore で包む。setTransform(1,0,0,1,0,0) で戻すと
      // Chart.js が掛けている devicePixelRatio のスケールまで消えてしまい、
      // 次以降のマーカーが半分の位置に描かれてしまう。
      ctx.save();
      ctx.translate(labelX - 3, chartArea.top + 6);
      ctx.rotate(Math.PI / 2);
      ctx.font = '600 11px "Pretendard JP", system-ui, sans-serif';
      ctx.fillStyle = marker.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    });

    ctx.restore();
  }
};

Chart.register(percentileLinesPlugin);

/* ------------------------------------------------------------------ */
/* ビン境界ガイド線 プラグイン                                          */
/* ------------------------------------------------------------------ */

/** ガイド線の最小間隔 (px)。これを割る場合はガイド線を倍々に間引く。 */
const MIN_GUIDE_GAP = 12;

/**
 * ラベルを「カテゴリ中央」から「ビン下端」へ移すためのピクセル量 (負値)。
 * 目盛り間隔をスケール自身から求めるので、軸の内側パディングに依存しない。
 */
function halfBinShift(scale) {
  return scale.getPixelForValue(0) - scale.getPixelForValue(0.5);
}

/**
 * X 軸の目盛りごとに、そこから立ち上がる縦のガイド線を引く。
 *
 * カテゴリ軸の目盛りラベルは既定でビンの「中央」に描かれるが、
 * ラベルが示す値 (binLabels) はビンの「下端」である。そこで
 *   1) labelOffset で半ビン分ラベルを左へ寄せ、数字を境界の真上に置く
 *   2) 同じ位置にガイド線を引く
 * ことで、ラベル・ガイド線・パーセンタイル線がすべて同じ実値で揃う。
 *
 * Chart.js 標準の grid は使わない。autoSkip で目盛りが間引かれると
 * grid.offset の補正量が「隣の目盛りまでの半分」= 複数ビン分になり、
 * ラベルとガイド線がずれてしまうため。
 *
 * chart.options.plugins.binGuideLines = { enabled: true, color }
 */
export const binGuideLinesPlugin = {
  id: 'binGuideLines',

  /** ラベルをビン境界へ寄せる。ビン数は更新のたびに変わるので毎レイアウトで再計算する。 */
  afterLayout(chart, _args, pluginOptions) {
    if (!pluginOptions?.enabled) return;
    const scale = chart.scales?.x;
    if (!scale || !chart.data?.labels?.length) return;
    scale.options.ticks.labelOffset = halfBinShift(scale);
  },

  /** 棒の背面に描く (前面だと分布そのものが読みにくくなる)。 */
  beforeDatasetsDraw(chart, _args, pluginOptions) {
    if (!pluginOptions?.enabled) return;
    const scale = chart.scales?.x;
    const { ctx, chartArea } = chart;
    if (!scale || !chartArea || !chart.data?.labels?.length) return;

    const n = chart.data.labels.length;

    // ラベルは autoSkip で間引かれるが、ガイド線はビン境界 (= 50ms ごと) に引く。
    // ただし線が潰れないよう、間隔が MIN_GUIDE_GAP を割る場合だけ倍々で間引く。
    const binSpan = scale.getPixelForValue(1) - scale.getPixelForValue(0);
    let step = 1;
    while (binSpan * step < MIN_GUIDE_GAP) step *= 2;

    ctx.save();
    ctx.strokeStyle = pluginOptions.color || COLORS.guide;
    ctx.lineWidth = 1;

    // カテゴリ v の下端は v - 0.5 の位置。最後の 1 本は右端の境界。
    for (let v = 0; v <= n; v += step) {
      // +0.5 は 1px 線をピクセル境界に載せて滲みを防ぐため
      const x = Math.round(scale.getPixelForValue(v - 0.5)) + 0.5;
      if (x < chartArea.left || x > chartArea.right) continue;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
    }

    ctx.restore();
  }
};

Chart.register(binGuideLinesPlugin);

/* ------------------------------------------------------------------ */
/* ヒストグラム                                                        */
/* ------------------------------------------------------------------ */

// ラベルは常にビンの「下端」を示す。binGuideLinesPlugin が描画位置を
// ビン境界へ合わせるため、上端を出すと数字とガイド線がずれてしまう。
function binLabels(histogram) {
  const { edges, mode } = histogram;
  const labels = [];
  for (let b = 0; b < edges.length - 1; b++) {
    labels.push(mode === 'log' ? formatMs(edges[b]) : String(edges[b]));
  }
  return labels;
}

function formatMs(v) {
  if (v >= 1000) return `${v / 1000}s`;
  return `${v}ms`;
}

/**
 * メインヒストグラムを生成/更新する。
 * @returns {Chart}
 */
export function renderHistogram(canvas, existing, histogram, markers, options = {}) {
  const { logScaleY = false, onBarClick, comparison = null, comparisonLabel = '前回' } = options;

  const labels = binLabels(histogram);
  const counts = histogram.counts.slice();
  const cum = cumulativeRatios(histogram);

  // オーバーフロー分は最終ビンに合算し、色で区別する (§3.6)
  const hasOverflow = histogram.overflowCount > 0;
  if (hasOverflow) {
    labels.push(`${histogram.xMax}+`);
    counts.push(histogram.overflowCount);
    cum.push(100);
  }

  const backgroundColor = counts.map((_, i) =>
    hasOverflow && i === counts.length - 1 ? COLORS.overflow : COLORS.bar
  );
  const hoverBackgroundColor = counts.map((_, i) =>
    hasOverflow && i === counts.length - 1 ? COLORS.overflowHover : COLORS.barHover
  );

  // 比較モード: 同じビン境界に当てはめた前回データを半透明で重ねる
  let comparisonCounts = null;
  if (comparison) {
    comparisonCounts = comparison.counts.slice();
    if (hasOverflow) comparisonCounts.push(comparison.overflowCount);
  }

  const datasets = [
    {
      label: '今回',
      data: counts,
      backgroundColor,
      hoverBackgroundColor,
      borderWidth: 0,
      // 比較時は並列配置ではなく重畳させる (grouped: false)
      grouped: !comparisonCounts,
      order: 2,
      // 参照画像同様、棒の間に隙間を作らない
      categoryPercentage: 1.0,
      barPercentage: 1.0
    }
  ];

  if (comparisonCounts) {
    // 前回データは背面にグレーで敷き、今回の棒より高い部分だけがはみ出して見える
    datasets.push({
      label: comparisonLabel,
      data: comparisonCounts,
      backgroundColor: 'rgba(100, 116, 139, 0.35)',
      hoverBackgroundColor: 'rgba(100, 116, 139, 0.5)',
      borderWidth: 0,
      grouped: false,
      order: 1,
      categoryPercentage: 1.0,
      barPercentage: 1.0
    });
  }

  if (existing) {
    existing.data.labels = labels;
    existing.data.datasets = datasets;
    existing.$cumulative = cum;
    existing.$histogram = histogram;
    existing.options.scales.y.type = logScaleY ? 'logarithmic' : 'linear';
    existing.options.plugins.legend.display = !!comparisonCounts;
    existing.options.plugins.percentileLines.markers = markers;
    existing.options.plugins.percentileLines.edges = histogram.edges;
    existing.update();
    return existing;
  }

  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      onClick: (evt, elements) => {
        if (!onBarClick || !elements.length) return;
        const hit = elements.find((e) => e.datasetIndex === 0) || elements[0];
        onBarClick(hit.index);
      },
      scales: {
        x: {
          title: { display: true, text: '応答時間 (ms)', color: COLORS.textSub, font: { size: 11 } },
          // ガイド線は binGuideLinesPlugin が描く (標準 grid はビン境界に揃わない)
          grid: { display: false },
          ticks: {
            color: COLORS.textSub,
            font: { size: 10 },
            // 目盛りの密度はラベル幅から autoSkip に決めさせる。
            // maxTicksLimit は指定しない (ガイド線の本数も引きずられるため)。
            autoSkip: true,
            maxRotation: 0,
            // 実値は binGuideLinesPlugin が毎レイアウトで設定する
            labelOffset: 0
          }
        },
        y: {
          type: logScaleY ? 'logarithmic' : 'linear',
          beginAtZero: !logScaleY,
          title: { display: true, text: 'トランザクション件数', color: COLORS.textSub, font: { size: 11 } },
          grid: { color: COLORS.grid },
          ticks: { color: COLORS.textSub, font: { size: 10 } }
        }
      },
      plugins: {
        legend: {
          display: !!comparisonCounts,
          position: 'top',
          align: 'end',
          labels: { boxWidth: 10, boxHeight: 10, font: { size: 11 }, color: COLORS.textSub }
        },
        percentileLines: { markers, edges: histogram.edges },
        binGuideLines: { enabled: true },
        tooltip: {
          displayColors: !!comparisonCounts,
          callbacks: {
            title: (items) => {
              const i = items[0].dataIndex;
              const h = chart.$histogram;
              if (h.overflowCount > 0 && i === items[0].chart.data.labels.length - 1) {
                return `${fmtInt(h.xMax)}ms 以上`;
              }
              const lo = h.edges[i];
              const hi = h.edges[i + 1];
              return `${fmtInt(lo)} 〜 ${fmtInt(hi)}ms`;
            },
            label: (item) => {
              const count = item.raw;
              const isCurrent = item.datasetIndex === 0;
              const total = isCurrent
                ? chart.$histogram.total || 1
                : item.chart.data.datasets[item.datasetIndex].data.reduce((a, b) => a + b, 0) || 1;
              const ratio = (count / total) * 100;
              const head = `${item.dataset.label}: ${fmtInt(count)} 件 (${fmt(ratio)}%)`;
              if (!isCurrent) return head;
              return [head, `累計 ${fmt(chart.$cumulative[item.dataIndex])}%`];
            }
          }
        }
      }
    }
  });

  chart.$cumulative = cum;
  chart.$histogram = histogram;
  return chart;
}

/* ------------------------------------------------------------------ */
/* CDF                                                                 */
/* ------------------------------------------------------------------ */

export function renderCdf(canvas, existing, points, options = {}) {
  const { tailZoom = false } = options;
  const data = tailZoom ? points.filter((p) => p.x >= 90) : points;

  if (existing) {
    existing.data.datasets[0].data = data;
    existing.options.scales.x.min = tailZoom ? 90 : 0;
    existing.update();
    return existing;
  }

  return new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: '応答時間',
          data,
          parsing: false,
          borderColor: COLORS.bar,
          backgroundColor: 'rgba(67, 97, 238, 0.08)',
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.15
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: tailZoom ? 90 : 0,
          max: 100,
          title: { display: true, text: 'パーセンタイル (%)', color: COLORS.textSub, font: { size: 11 } },
          grid: { color: COLORS.grid },
          ticks: { color: COLORS.textSub, font: { size: 10 } }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: '応答時間 (ms)', color: COLORS.textSub, font: { size: 11 } },
          grid: { color: COLORS.grid },
          ticks: { color: COLORS.textSub, font: { size: 10 } }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => `P${items[0].parsed.x}`,
            label: (item) => `${fmt(item.parsed.y)} ms`
          }
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* アプリ別 P99 ランキング                                             */
/* ------------------------------------------------------------------ */

export function renderRanking(canvas, existing, rows, options = {}) {
  const labels = rows.map((r) => r.name);
  const data = rows.map((r) => r.p99);

  if (existing) {
    existing.data.labels = labels;
    existing.data.datasets[0].data = data;
    existing.$rows = rows;
    existing.update();
    return existing;
  }

  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'P99',
          data,
          backgroundColor: COLORS.bar,
          hoverBackgroundColor: COLORS.barHover,
          borderWidth: 0,
          borderRadius: 3
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 },
      onClick: (evt, elements) => {
        if (!options.onRowClick || !elements.length) return;
        options.onRowClick(chart.$rows[elements[0].index]);
      },
      scales: {
        x: {
          beginAtZero: true,
          title: { display: true, text: 'P99 応答時間 (ms)', color: COLORS.textSub, font: { size: 11 } },
          grid: { color: COLORS.grid },
          ticks: { color: COLORS.textSub, font: { size: 10 } }
        },
        y: {
          grid: { display: false },
          ticks: {
            color: COLORS.text,
            font: { size: 10 },
            callback(value) {
              const label = this.getLabelForValue(value);
              return label.length > 34 ? `${label.slice(0, 33)}…` : label;
            }
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => chart.$rows[items[0].dataIndex].name,
            label: (item) => {
              const row = chart.$rows[item.dataIndex];
              return [
                `P99: ${fmt(row.p99)} ms`,
                `P50: ${fmt(row.p50)} ms`,
                `件数: ${fmtInt(row.count)}`
              ];
            }
          }
        }
      }
    }
  });

  chart.$rows = rows;
  return chart;
}

export { fmt, fmtInt };
