/**
 * 統計エンジン
 *
 * - TxStore: X-Viewトランザクションを SoA (Structure of Arrays) で保持する。
 *   30万件規模でもブラウザが耐えられるよう、数値は TypedArray、
 *   文字列(アプリ名/インスタンス名/エラー種別/ビジネス組合せ)はインターン化して
 *   Int32Array のインデックスとして持つ。
 * - パーセンタイルは線形補間による正確算出 (ビン近似はテールで誤差が出るため不採用)。
 */

import { parseApiTime } from './api.js';

const INITIAL_CAPACITY = 65536;

function grow(arr, capacity, Ctor) {
  const next = new Ctor(capacity);
  next.set(arr);
  return next;
}

/** 文字列 -> 連番インデックスのインターンテーブル */
class Interner {
  constructor() {
    this.values = [];
    this.map = new Map();
  }
  intern(value) {
    const key = value ?? '';
    let idx = this.map.get(key);
    if (idx === undefined) {
      idx = this.values.length;
      this.values.push(key);
      this.map.set(key, idx);
    }
    return idx;
  }
  get(idx) {
    return this.values[idx] ?? '';
  }
}

export class TxStore {
  constructor() {
    this.length = 0;
    this.capacity = INITIAL_CAPACITY;

    this.responseTime = new Float64Array(this.capacity);
    this.startTime = new Float64Array(this.capacity);
    this.cpuTime = new Float64Array(this.capacity);
    this.sqlTime = new Float64Array(this.capacity);
    this.fetchTime = new Float64Array(this.capacity);
    this.externalTime = new Float64Array(this.capacity);

    this.appIdx = new Int32Array(this.capacity);
    this.instIdx = new Int32Array(this.capacity);
    this.errIdx = new Int32Array(this.capacity);
    this.bizIdx = new Int32Array(this.capacity);

    this.apps = new Interner();
    this.instances = new Interner();
    this.errors = new Interner();
    this.bizKeys = new Interner();

    /** bizKey インデックス -> businessId の数値配列 */
    this.bizSets = [];
    /** 詳細パネル用。行インデックスと同じ並びの txid */
    this.txids = [];
  }

  _ensure(extra) {
    if (this.length + extra <= this.capacity) return;
    let capacity = this.capacity;
    while (this.length + extra > capacity) capacity *= 2;

    this.responseTime = grow(this.responseTime, capacity, Float64Array);
    this.startTime = grow(this.startTime, capacity, Float64Array);
    this.cpuTime = grow(this.cpuTime, capacity, Float64Array);
    this.sqlTime = grow(this.sqlTime, capacity, Float64Array);
    this.fetchTime = grow(this.fetchTime, capacity, Float64Array);
    this.externalTime = grow(this.externalTime, capacity, Float64Array);
    this.appIdx = grow(this.appIdx, capacity, Int32Array);
    this.instIdx = grow(this.instIdx, capacity, Int32Array);
    this.errIdx = grow(this.errIdx, capacity, Int32Array);
    this.bizIdx = grow(this.bizIdx, capacity, Int32Array);

    this.capacity = capacity;
  }

  /** API レスポンスの result 配列を追記する */
  push(rows) {
    if (!rows || !rows.length) return;
    this._ensure(rows.length);

    for (const row of rows) {
      const rt = Number(row.responseTime);
      if (!Number.isFinite(rt)) continue;

      const i = this.length;
      this.responseTime[i] = rt;

      const st = parseApiTime(row.startTime);
      this.startTime[i] = st ? st.getTime() : NaN;

      this.cpuTime[i] = Number(row.cpuTime) || 0;
      this.sqlTime[i] = Number(row.sqlTime) || 0;
      this.fetchTime[i] = Number(row.fetchTime) || 0;
      this.externalTime[i] = Number(row.externalcallTime) || 0;

      this.appIdx[i] = this.apps.intern(row.applicationName);
      this.instIdx[i] = this.instances.intern(row.instanceName);
      this.errIdx[i] = this.errors.intern(row.errorType);

      // businessId は配列で返る (付録 5.9.4.5)。組合せごとにインターン化する。
      const bizList = Array.isArray(row.businessId)
        ? row.businessId.map(Number).filter(Number.isFinite)
        : [];
      const bizKey = bizList.join(',');
      const bIdx = this.bizKeys.intern(bizKey);
      if (this.bizSets[bIdx] === undefined) this.bizSets[bIdx] = bizList;
      this.bizIdx[i] = bIdx;

      this.txids[i] = row.txid ?? '';
      this.length++;
    }
  }

  /** 行 i を詳細パネル向けのプレーンオブジェクトに復元する */
  row(i) {
    return {
      index: i,
      txid: this.txids[i],
      responseTime: this.responseTime[i],
      startTime: this.startTime[i],
      cpuTime: this.cpuTime[i],
      sqlTime: this.sqlTime[i],
      fetchTime: this.fetchTime[i],
      externalTime: this.externalTime[i],
      applicationName: this.apps.get(this.appIdx[i]),
      instanceName: this.instances.get(this.instIdx[i]),
      errorType: this.errors.get(this.errIdx[i]),
      businessIds: this.bizSets[this.bizIdx[i]] || []
    };
  }
}

/* ------------------------------------------------------------------ */
/* フィルタ                                                            */
/* ------------------------------------------------------------------ */

/**
 * クライアント側フィルタ (§3.5)。
 * API に business_id パラメータが無いため、ビジネス絞り込みはここで行う。
 * @returns {Int32Array} 条件を満たす行インデックス
 */
export function filterIndices(store, filters = {}) {
  const { businessId, errorMode = 'all', appKeyword = '', rtMin, rtMax } = filters;
  const keyword = appKeyword.trim().toLowerCase();

  // ビジネス絞り込み: 該当する bizKey インデックスを事前に判定しておく
  let bizAllowed = null;
  if (businessId !== undefined && businessId !== null && businessId !== '') {
    const target = Number(businessId);
    bizAllowed = new Uint8Array(store.bizKeys.values.length);
    store.bizSets.forEach((ids, idx) => {
      bizAllowed[idx] = ids && ids.includes(target) ? 1 : 0;
    });
  }

  // アプリ名絞り込みも同様に、インターンテーブル側で1回だけ判定する
  let appAllowed = null;
  if (keyword) {
    appAllowed = new Uint8Array(store.apps.values.length);
    store.apps.values.forEach((name, idx) => {
      appAllowed[idx] = name.toLowerCase().includes(keyword) ? 1 : 0;
    });
  }

  // 正常(errorType === '')がまだ1件も現れていない場合に備えて -1 を既定にする
  const normalIdx = store.errors.map.has('') ? store.errors.map.get('') : -1;
  const out = new Int32Array(store.length);
  let n = 0;

  for (let i = 0; i < store.length; i++) {
    if (bizAllowed && !bizAllowed[store.bizIdx[i]]) continue;
    if (appAllowed && !appAllowed[store.appIdx[i]]) continue;

    if (errorMode === 'error' && store.errIdx[i] === normalIdx) continue;
    if (errorMode === 'normal' && store.errIdx[i] !== normalIdx) continue;

    const rt = store.responseTime[i];
    if (rtMin !== undefined && rt < rtMin) continue;
    if (rtMax !== undefined && rt > rtMax) continue;

    out[n++] = i;
  }
  return out.subarray(0, n);
}

/** 指定インデックスの応答時間を昇順ソート済み Float64Array で返す */
export function sortedResponseTimes(store, indices) {
  const values = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i++) values[i] = store.responseTime[indices[i]];
  values.sort(); // TypedArray の sort は数値ソートが既定
  return values;
}

/* ------------------------------------------------------------------ */
/* パーセンタイル・要約統計                                            */
/* ------------------------------------------------------------------ */

/** 線形補間方式のパーセンタイル。sorted は昇順ソート済みであること */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = ((n - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export const PERCENTILE_LEVELS = [50, 75, 90, 95, 99, 99.9];

export function summarize(store, indices, sorted) {
  const n = sorted.length;
  const result = {
    count: n,
    mean: NaN, min: NaN, max: NaN, stdev: NaN,
    errorCount: 0, errorRate: NaN,
    percentiles: {}
  };
  if (n === 0) return result;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  const mean = sum / n;

  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = sorted[i] - mean;
    sq += d * d;
  }

  result.mean = mean;
  result.min = sorted[0];
  result.max = sorted[n - 1];
  result.stdev = Math.sqrt(sq / n);

  const normalIdx = store.errors.map.has('') ? store.errors.map.get('') : -1;
  let errors = 0;
  for (let i = 0; i < indices.length; i++) {
    if (store.errIdx[indices[i]] !== normalIdx) errors++;
  }
  result.errorCount = errors;
  result.errorRate = (errors / n) * 100;

  PERCENTILE_LEVELS.forEach((p) => {
    result.percentiles[p] = percentile(sorted, p);
  });

  return result;
}

/* ------------------------------------------------------------------ */
/* ヒストグラム                                                        */
/* ------------------------------------------------------------------ */

/** 1 / 2 / 5 × 10^n の「きりの良い数」に丸める */
export function niceNumber(value, mode = 'ceil') {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const pow = Math.pow(10, exp);
  const frac = value / pow;
  const steps = [1, 2, 2.5, 5, 10];
  if (mode === 'ceil') {
    for (const s of steps) if (frac <= s + 1e-9) return s * pow;
    return 10 * pow;
  }
  let best = steps[0];
  for (const s of steps) if (s <= frac + 1e-9) best = s;
  return best * pow;
}

/**
 * 応答時間分布の既定ビン幅 (ms)。
 * X 軸の目盛りとガイド線はビン境界に引かれるため、この値がそのまま目盛り間隔になる。
 */
export const DEFAULT_BIN_WIDTH = 50;

/** 自動モードでのビン数上限。超える場合は 50ms の倍数へ広げる。 */
const MAX_AUTO_BINS = 240;

/** 自動モードでのビン数下限。応答が速い環境で棒 1 本になるのを避ける。 */
const MIN_AUTO_BINS = 4;

/**
 * ヒストグラムのビンを構築する (§3.6)。
 *
 * @param {Float64Array} sorted 昇順ソート済み応答時間
 * @param {object} opts
 * @param {'auto'|'log'|'manual'} [opts.mode='auto']
 * @param {number} [opts.binWidth]  manual 時のビン幅
 * @param {number} [opts.xMax]      manual 時の X 軸上限
 */
export function buildHistogram(sorted, opts = {}) {
  const { mode = 'auto' } = opts;
  const n = sorted.length;
  if (n === 0) {
    return { mode, edges: [], counts: [], overflowCount: 0, xMax: 0, binWidth: 0, total: 0 };
  }

  if (mode === 'log') return buildLogHistogram(sorted);

  let xMax;
  let binWidth;

  if (mode === 'manual' && opts.xMax > 0 && opts.binWidth > 0) {
    xMax = opts.xMax;
    binWidth = opts.binWidth;
  } else {
    // ビン幅は 50ms 固定。X 軸の目盛りが常に 0/50/100... と読めるようにするため、
    // 幅をデータに合わせて動かさない (niceNumber による可変幅は使わない)。
    binWidth = DEFAULT_BIN_WIDTH;
    // 表示上限は P99.5 をビン幅の倍数へ切り上げ。極端な外れ値に軸を支配させない。
    const p995 = percentile(sorted, 99.5);
    // 全件が 50ms 未満でも棒 1 本にならないよう、最低 4 ビン分の軸を確保する
    xMax = Math.max(Math.ceil(Math.max(p995, 1) / binWidth) * binWidth, binWidth * MIN_AUTO_BINS);
    // 裾が極端に重い場合でも棒が増えすぎないよう、50ms の倍数へ広げる
    // (倍数のままなので目盛りは 0/50/100... の並びを保つ)。
    if (xMax / binWidth > MAX_AUTO_BINS) {
      binWidth = Math.ceil(xMax / MAX_AUTO_BINS / DEFAULT_BIN_WIDTH) * DEFAULT_BIN_WIDTH;
      xMax = Math.ceil(xMax / binWidth) * binWidth;
    }
  }

  const binCount = Math.max(1, Math.ceil(xMax / binWidth));
  const counts = new Array(binCount).fill(0);
  let overflowCount = 0;

  for (let i = 0; i < n; i++) {
    const v = sorted[i];
    const b = Math.floor(v / binWidth);
    // 上限超過分は最終ビンに合算 (クリッピング)。参照画像右端の突出した棒がこれ。
    if (b >= binCount) overflowCount++;
    else counts[b]++;
  }

  const edges = [];
  for (let b = 0; b <= binCount; b++) edges.push(b * binWidth);

  return { mode, edges, counts, overflowCount, xMax, binWidth, total: n };
}

/** レンジが 3 桁以上開く環境向けのログビン */
function buildLogHistogram(sorted) {
  const n = sorted.length;
  const max = sorted[n - 1];
  const minPositive = Math.max(sorted.find((v) => v > 0) ?? 1, 1);

  const startExp = Math.floor(Math.log10(minPositive));
  const endExp = Math.ceil(Math.log10(Math.max(max, 10)));

  const edges = [0];
  for (let e = startExp; e <= endExp; e++) {
    for (const m of [1, 2, 5]) {
      const edge = m * Math.pow(10, e);
      if (edge > edges[edges.length - 1]) edges.push(edge);
    }
  }

  const counts = new Array(edges.length - 1).fill(0);
  let cursor = 0;
  for (let b = 0; b < counts.length; b++) {
    const upper = edges[b + 1];
    while (cursor < n && sorted[cursor] < upper) {
      counts[b]++;
      cursor++;
    }
  }
  const overflowCount = n - cursor;

  return {
    mode: 'log',
    edges,
    counts,
    overflowCount,
    xMax: edges[edges.length - 1],
    binWidth: null,
    total: n
  };
}

/**
 * 既存のヒストグラムと同じビン境界に別のデータ系列を当てはめる。
 * 比較モードで軸を完全に揃えるために使う。
 */
export function applyHistogramEdges(sorted, reference) {
  const { edges, xMax } = reference;
  const counts = new Array(Math.max(edges.length - 1, 0)).fill(0);
  let overflowCount = 0;

  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    if (v >= xMax) {
      overflowCount++;
      continue;
    }
    // ビンは等間隔とは限らない(ログビン)ため二分探索で求める
    let lo = 0;
    let hi = counts.length - 1;
    let bin = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (v < edges[mid]) hi = mid - 1;
      else if (v >= edges[mid + 1]) lo = mid + 1;
      else { bin = mid; break; }
    }
    if (bin >= 0) counts[bin]++;
    else overflowCount++;
  }

  return { ...reference, counts, overflowCount, total: sorted.length };
}

/** ヒストグラムの累積比率 (CDF) を返す */
export function cumulativeRatios(histogram) {
  const out = [];
  let acc = 0;
  const total = histogram.total || 1;
  histogram.counts.forEach((c) => {
    acc += c;
    out.push((acc / total) * 100);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* CDF・アプリ別ランキング                                             */
/* ------------------------------------------------------------------ */

/** パーセンタイル曲線用の {x: percentile, y: ms} 配列 */
export function buildCdfPoints(sorted, step = 0.5) {
  const points = [];
  if (!sorted.length) return points;
  for (let p = 0; p <= 100; p += step) {
    points.push({ x: Number(p.toFixed(1)), y: percentile(sorted, p) });
  }
  // テール側の解像度を上げる
  [99.2, 99.4, 99.6, 99.8, 99.9, 99.95, 99.99].forEach((p) => {
    points.push({ x: p, y: percentile(sorted, p) });
  });
  points.sort((a, b) => a.x - b.x);
  return points;
}

/** アプリケーション別 P99 ランキング (上位 topN) */
export function appRanking(store, indices, topN = 10, minSamples = 5) {
  const buckets = new Map();
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const key = store.appIdx[idx];
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(store.responseTime[idx]);
  }

  const rows = [];
  buckets.forEach((values, appIdx) => {
    if (values.length < minSamples) return;
    const arr = Float64Array.from(values);
    arr.sort();
    rows.push({
      name: store.apps.get(appIdx),
      count: arr.length,
      p99: percentile(arr, 99),
      p50: percentile(arr, 50)
    });
  });

  rows.sort((a, b) => b.p99 - a.p99);
  return rows.slice(0, topN);
}
