/**
 * 照会期間 (開始/終了時刻・プリセット) の入力と、チャンク数の表示
 */
import { buildChunks } from './api.js';
import { el } from './dom.js';

export function toLocalInput(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

export function rangeLabel(range) {
  const p = (n) => String(n).padStart(2, '0');
  const t = (d) => `${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${t(range.start)}–${t(range.end)}`;
}

export function readRange() {
  const start = el.startInput.value ? new Date(el.startInput.value) : null;
  const end = el.endInput.value ? new Date(el.endInput.value) : null;
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return null;
  return { start, end };
}

export function setPreset(minutes) {
  const end = new Date();
  end.setMilliseconds(0);
  const start = new Date(end.getTime() - minutes * 60 * 1000);
  el.startInput.value = toLocalInput(start);
  el.endInput.value = toLocalInput(end);
  updateChunkBadge();
}

export function updateChunkBadge() {
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
/* ドメイン階層セレクタ (ツリー構築は PTA と共通: shared/domain-tree.js)                                  */
/* ------------------------------------------------------------------ */
