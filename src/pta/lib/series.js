/**
 * PTA の時系列データ処理 (純粋関数。DOM・グローバル状態に依存しない)
 */
import { parseDateString } from './format.js';

/**
 * リクエスト数 (service_count) で加重して平均する指標。
 * 日平均の単純平均だと、閑散日と繁忙日が同じ重みになり、期間全体の平均応答時間・エラー率とずれる。
 * (TPS・同時ユーザ・CPU・ヒープは単純平均が正しいので対象外)
 */
const HIT_WEIGHTED_METRICS = new Set(['service_time', 'err_rate']);
export const isHitWeighted = (metric) => HIT_WEIGHTED_METRICS.has(metric);

/** 件数の時系列 -> time をキーにした重みの Map */
export function weightMap(countSeries) {
  return new Map((countSeries || []).map((d) => [d.time, d.value]));
}

/**
 * 平均。全要素に有限の重み w があり、重みの合計が正なら加重平均、そうでなければ単純平均。
 * (一部の日だけ重みが欠けている場合に、欠けた日を黙って捨てて偏らせないため、全体を単純平均に戻す)
 * @param {{v:number, w:number|null}[]} entries
 */
function meanOf(entries) {
  let sum = 0;
  let weightedSum = 0;
  let weightSum = 0;
  let hasAllWeights = true;
  for (const { v, w } of entries) {
    sum += v;
    if (w === null || w === undefined || !Number.isFinite(w)) hasAllWeights = false;
    else {
      weightedSum += v * w;
      weightSum += w;
    }
  }
  return hasAllWeights && weightSum > 0 ? weightedSum / weightSum : sum / entries.length;
}

/** 複数チャンクの結果を結合し、time の昇順に並べ、同じ time の重複を除く */
export function mergeSeries(resArray) {
  const metricData = [];
  resArray.forEach((res) => { metricData.push(...res); });
  metricData.sort((a, b) => String(a.time).localeCompare(String(b.time)));

  const uniqueData = [];
  const timeSet = new Set();
  metricData.forEach((item) => {
    if (!timeSet.has(item.time)) {
      timeSet.add(item.time);
      uniqueData.push(item);
    }
  });
  return uniqueData;
}

/**
 * 複数チャンクの結果を結合して time の昇順に並べる (重複は除かない)。
 * ヒートマップ用: 同じ time のデータは存在しない前提で、そのまま保持する。
 */
export function flattenSorted(resArray) {
  const out = [];
  resArray.forEach((res) => { out.push(...res); });
  out.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return out;
}

/**
 * エラー率 (%) の時系列を作る。配列インデックスではなく time をキーに突き合わせる
 * (月単位の取得失敗で系列がずれるため)。リクエスト 0 件の日は 0% ではなく null (欠測) とし、
 * 平均に 0 として混ざらないようにする。
 */
export function computeErrRate(countData, errCountData) {
  const errCountByTime = new Map(errCountData.map((e) => [e.time, e.value]));
  return countData.map((item) => {
    const count = item.value || 0;
    const errCount = errCountByTime.get(item.time) || 0;
    return { time: item.time, value: count > 0 ? (errCount / count) * 100 : null };
  });
}

/** 単純移動平均。先頭の period-1 件は null。欠測値は 0 として扱う */
export function calculateSMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j] || 0;
      }
      result.push(sum / period);
    }
  }
  return result;
}

/**
 * 月別平均と前月比 (%) を計算する。
 * @param {{time:string,value:number|null}[]} data 日次データ (time 昇順)
 * @param {{metric:string, todayStr:string, weights?:Map<string,number>|null}} opts
 *   todayStr は "yyyyMMdd" (それより未来のデータは除外)。weights を渡すと、その重み (リクエスト数) で月平均を加重する。
 *   重みが無い、または月内に重みの欠けた日がある場合、その月は単純平均になる。
 * @returns {Object<string,{avg:number, prevAvgMonth:string|null, rate:number|null}>} キーは "MM"
 */
export function computeMonthlyAverages(data, { metric, todayStr, weights = null }) {
  const cache = {};
  const monthData = {};

  // 当月は今日までのデータだけを平均に使う (未来日のゼロ埋めを含めない)
  data.forEach((item) => {
    if (item.time > todayStr) return;
    // 0 や欠測は除外する。ただしエラー率は 0% が正常値なので 0 を残す
    if (item.value === null || item.value === undefined) return;
    if (item.value === 0 && metric !== 'err_rate') return;

    const month = parseDateString(item.time).split('/')[0];
    if (!monthData[month]) monthData[month] = [];
    monthData[month].push({ v: item.value, w: weights ? (weights.get(item.time) ?? null) : null });
  });

  // データは時系列順なので、月の出現順を求める
  const monthsInOrder = [];
  let lastM = null;
  data.forEach((item) => {
    const lbl = parseDateString(item.time);
    if (typeof lbl !== 'string') return;

    const m = lbl.split('/')[0];
    if (m !== lastM) {
      monthsInOrder.push(m);
      lastM = m;
    }
  });

  monthsInOrder.forEach((m, idx) => {
    const prevAvgMonth = idx > 0 ? monthsInOrder[idx - 1] : null;
    if (!monthData[m] || monthData[m].length === 0) {
      cache[m] = { avg: 0, prevAvgMonth };
      return;
    }
    cache[m] = { avg: meanOf(monthData[m]), prevAvgMonth };
  });

  // 前月比
  monthsInOrder.forEach((m, idx) => {
    const d = cache[m];
    if (!d) return;

    if (d.prevAvgMonth && cache[d.prevAvgMonth]) {
      let prevAvg;
      const isLastMonth = (idx === monthsInOrder.length - 1);

      if (isLastMonth) {
        // 同条件の比較: 当月の有効日数と同じ日数分だけ、前月の月初から取って平均する
        const currentMonthCount = (monthData[m] || []).length;
        const prevMonthData = monthData[d.prevAvgMonth] || [];

        if (currentMonthCount > 0 && prevMonthData.length > 0) {
          prevAvg = meanOf(prevMonthData.slice(0, currentMonthCount));
        } else {
          prevAvg = cache[d.prevAvgMonth].avg;
        }
      } else {
        prevAvg = cache[d.prevAvgMonth].avg;
      }

      d.rate = prevAvg > 0 ? ((d.avg - prevAvg) / prevAvg) * 100 : 0;
    } else {
      d.rate = null;
    }
  });

  return cache;
}

/**
 * 平均値。0 は「データなし」として除外するが、エラー率の 0% は正常値なので keepZero=true で残す。
 * 未来日 (time > todayStr) と null/undefined は常に除外する。
 * weights (time -> リクエスト数) を渡すと加重平均にする。重みが欠けた日がある場合は単純平均に戻る。
 */
export function averageValid(data, todayStr, keepZero = false, weights = null) {
  const validData = data.filter((d) =>
    d.time <= todayStr &&
    (keepZero || d.value !== 0) && d.value !== null && d.value !== undefined
  );
  if (validData.length === 0) return 0;
  return meanOf(validData.map((d) => ({ v: d.value, w: weights ? (weights.get(d.time) ?? null) : null })));
}

/** インデックス範囲 [startIdx, endIdx] で切り出す (範囲外は丸める) */
export function sliceRange(arr, startIdx, endIdx) {
  if (!arr || arr.length === 0) return [];
  const s = Math.max(0, startIdx);
  const e = Math.min(arr.length - 1, endIdx);
  return arr.slice(s, e + 1);
}

/**
 * 選択期間のサマリを計算する。
 * @param {Object<string,{time:string,value:number|null}[]>} yearly 指標名 -> 日次データ
 * 平均応答時間とエラー率は、その日のリクエスト数 (service_count) で加重する (weighted=false で従来の単純平均)。
 * @returns {null | {peakDate:string|null, avgResponseTime:number, avgTps:number, avgConcurrentUsers:number,
 *   avgHits:number, avgSysCpu:number, avgHeapUsage:number, avgErrRate:number}} データなしなら null
 */
export function summarizeRange(yearly, startIdx, endIdx, { metric, todayStr, weighted = true }) {
  if (startIdx < 0 || endIdx < 0 || yearly.service_time.length === 0) return null;

  const slice = (key) => sliceRange(yearly[key], startIdx, endIdx);
  const counts = weighted ? weightMap(slice('service_count')) : null;

  // ピーク日 (選択中の指標で最大の日)
  const currentData = slice(metric);
  let peakDate = null;
  if (currentData.length > 0) {
    let maxEntry = currentData[0];
    currentData.forEach((entry) => {
      if (entry.value > maxEntry.value) maxEntry = entry;
    });
    peakDate = parseDateString(maxEntry.time, true);
  }

  return {
    peakDate,
    avgResponseTime: averageValid(slice('service_time'), todayStr, false, counts),
    avgTps: averageValid(slice('service_rate'), todayStr),
    avgConcurrentUsers: averageValid(slice('concurrent_user'), todayStr),
    avgHits: averageValid(slice('service_count'), todayStr),
    avgSysCpu: averageValid(slice('sys_cpu'), todayStr),
    avgHeapUsage: averageValid(slice('heap_usage'), todayStr),
    avgErrRate: averageValid(slice('err_rate'), todayStr, true, counts)
  };
}
