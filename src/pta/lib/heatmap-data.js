/**
 * PTA ヒートマップ用のデータ処理 (純粋関数。DOM・グローバル状態に依存しない)
 */

/**
 * 時間別の「値」「応答時間」「件数」を time をキーに結合する。
 * 配列インデックスではなく time で突き合わせる (チャンク取得失敗・欠測でずれるため)。
 *
 * @param {string} metric 選択中の指標。'service_count' なら値はヒット数、'err_rate' なら件数とエラー件数から算出
 * @returns {{time:string, value:number, yValue:number, count:number}[]}
 *   value: セルの値 / yValue: 散布図の Y 軸・一覧に出す値 (ヒット数選択時は応答時間) / count: ヒット数
 */
export function combineHeatmapData(timeData, countData, errCountData, metric) {
  const countByTime = new Map(countData.map((c) => [c.time, c]));
  const errCountByTime = new Map(errCountData.map((e) => [e.time, e]));

  return timeData.map((timeItem) => {
    const countItem = countByTime.get(timeItem.time);
    const errCountItem = (metric === 'err_rate') ? errCountByTime.get(timeItem.time) : null;

    let value = timeItem.value;
    if (metric === 'service_count') {
      value = countItem ? countItem.value : 0;
    } else if (metric === 'err_rate') {
      const c = countItem ? countItem.value : 0;
      const e = errCountItem ? errCountItem.value : 0;
      value = c > 0 ? (e / c) * 100 : 0;
    }

    return {
      time: timeItem.time,
      value,
      yValue: (metric === 'service_count') ? timeItem.value : value,
      count: countItem ? countItem.value : 0
    };
  });
}

/**
 * 曜日×時間 (7×24) に集計する。時刻は time 文字列 (yyyyMMddHH...) の HH から求める。
 * 欠測の時間帯や当日の部分データがあってもセルが隣へずれないようにするため。
 * HH が取れない形式の場合のみ、日内の順序で代用する。件数 0 の項目は集計しない。
 *
 * @returns {{sum:number, count:number, data:object[]}[][]} [曜日(0=日)][時]
 */
export function buildDayHourMap(data) {
  const dayHourMap = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ sum: 0, count: 0, data: [] }))
  );

  const groupedByDate = {};
  data.forEach((item) => {
    const dateKey = String(item.time).substring(0, 8);
    if (!groupedByDate[dateKey]) groupedByDate[dateKey] = [];
    groupedByDate[dateKey].push(item);
  });

  Object.entries(groupedByDate).forEach(([dateKey, items]) => {
    const year = parseInt(dateKey.substring(0, 4));
    const month = parseInt(dateKey.substring(4, 6)) - 1;
    const day = parseInt(dateKey.substring(6, 8));
    const dayIdx = new Date(year, month, day).getDay();

    items.forEach((item, posInDay) => {
      const hh = parseInt(String(item.time).substring(8, 10), 10);
      const hour = Number.isInteger(hh) && hh >= 0 && hh < 24 ? hh : posInDay % 24;
      if (item.count > 0) {
        dayHourMap[dayIdx][hour].sum += item.value;
        dayHourMap[dayIdx][hour].count++;
        dayHourMap[dayIdx][hour].data.push(item);
      }
    });
  });

  return dayHourMap;
}

/** 集計済みマップから、データのあるセルの平均値だけを一次元配列にする */
export function dayHourAverages(dayHourMap) {
  const averages = [];
  dayHourMap.forEach((day) => {
    day.forEach((cell) => {
      if (cell.count > 0) averages.push(cell.sum / cell.count);
    });
  });
  return averages;
}

/**
 * p (0〜1) 分位数 (線形補間)。arr は昇順ソート済みであること。
 */
export function quantile(arr, p) {
  if (arr.length === 0) return 0;
  if (typeof p !== 'number') throw new TypeError('p must be a number');
  if (p <= 0) return arr[0];
  if (p >= 1) return arr[arr.length - 1];
  const index = (arr.length - 1) * p;
  const lower = Math.floor(index);
  const upper = lower + 1;
  const weight = index % 1;
  if (upper >= arr.length) return arr[lower];
  return arr[lower] * (1 - weight) + arr[upper] * weight;
}

/**
 * IQR 法で「安定 / 警戒 / 高負荷」の境界を決める。
 * 安定: Q3 以下、警戒: Q3 + 1.5×IQR 以下、それを超えると高負荷。
 * 注意: 境界はそのデータの分布に対する相対値であり、絶対的な性能基準ではない。
 * @param {number[]} averages 昇順にソートしなくてよい (内部でコピーしてソートする)
 * @returns {{good:number, warning:number}|null} データがなければ null
 */
export function computeIqrThresholds(averages) {
  if (averages.length === 0) return null;
  const sorted = [...averages].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  return { good: q3, warning: q3 + (1.5 * (q3 - q1)) };
}

/** 昇順ソート済み配列の中央値 */
export function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Overall (六角ビン) ヒートマップの軸の基準値。件数 0 の項目は除外して求める。
 * X 軸 = ヒット数 / Y 軸 = yValue (性能指標)。
 * @returns {null | {medianX:number, maxX:number, medianY:number, maxY:number}} 有効データがなければ null
 */
export function computeOverallStats(data) {
  const validData = data.filter((d) => d.count > 0);
  if (validData.length === 0) return null;

  const counts = validData.map((d) => d.count).sort((a, b) => a - b);
  const times = validData.map((d) => d.yValue).sort((a, b) => a - b);
  return {
    medianX: median(counts),
    maxX: Math.max(...counts, 1),
    medianY: median(times),
    maxY: Math.max(...times, 100)
  };
}
