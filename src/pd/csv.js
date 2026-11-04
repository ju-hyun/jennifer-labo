/**
 * 集計結果の CSV エクスポート
 */
import { state } from './state.js';
import { showNotice } from './notice.js';
import { toLocalInput } from './range.js';

export function exportCsv() {
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
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ダウンロード開始前に URL を解放すると失敗するブラウザがあるため、少し遅らせる
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* ヘルプ                                                              */
/* ------------------------------------------------------------------ */
