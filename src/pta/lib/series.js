/**
 * PTA の時系列データ処理 (純粋関数。DOM・グローバル状態に依存しない)
 */
import { parseDateString } from './format.js';

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
 * @param {{metric:string, todayStr:string}} opts todayStr は "yyyyMMdd" (それより未来のデータは除外)
 * @returns {Object<string,{avg:number, prevAvgMonth:string|null, rate:number|null}>} キーは "MM"
 */
export function computeMonthlyAverages(data, { metric, todayStr }) {
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
    monthData[month].push(item.value);
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
    const arr = monthData[m];
    cache[m] = { avg: arr.reduce((acc, v) => acc + v, 0) / arr.length, prevAvgMonth };
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
          const prevMonthSlice = prevMonthData.slice(0, currentMonthCount);
          prevAvg = prevMonthSlice.reduce((acc, v) => acc + v, 0) / (prevMonthSlice.length || 1);
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
 */
export function averageValid(data, todayStr, keepZero = false) {
  const validData = data.filter((d) =>
    d.time <= todayStr &&
    (keepZero || d.value !== 0) && d.value !== null && d.value !== undefined
  );
  return validData.length ? validData.reduce((s, d) => s + d.value, 0) / validData.length : 0;
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
 * @returns {null | {peakDate:string|null, avgResponseTime:number, avgTps:number, avgConcurrentUsers:number,
 *   avgHits:number, avgSysCpu:number, avgHeapUsage:number, avgErrRate:number}} データなしなら null
 */
export function summarizeRange(yearly, startIdx, endIdx, { metric, todayStr }) {
  if (startIdx < 0 || endIdx < 0 || yearly.service_time.length === 0) return null;

  const slice = (key) => sliceRange(yearly[key], startIdx, endIdx);

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
    avgResponseTime: averageValid(slice('service_time'), todayStr),
    avgTps: averageValid(slice('service_rate'), todayStr),
    avgConcurrentUsers: averageValid(slice('concurrent_user'), todayStr),
    avgHits: averageValid(slice('service_count'), todayStr),
    avgSysCpu: averageValid(slice('sys_cpu'), todayStr),
    avgHeapUsage: averageValid(slice('heap_usage'), todayStr),
    avgErrRate: averageValid(slice('err_rate'), todayStr, true)
  };
}
