// PTA ヒートマップ用データ処理のテスト
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineHeatmapData, buildDayHourMap, dayHourAverages, cellAverage,
  computeIqrThresholds, median, computeOverallStats
} from '../src/pta/lib/heatmap-data.js';

const d = (time, value) => ({ time, value });

describe('combineHeatmapData', () => {
  const time = [d('2026110300', 200), d('2026110301', 300)];
  const count = [d('2026110300', 10), d('2026110301', 20)];

  test('応答時間: value=yValue=応答時間、count は time で結合', () => {
    const r = combineHeatmapData(time, count, [], 'service_time');
    assert.deepEqual(r, [
      { time: '2026110300', value: 200, yValue: 200, count: 10 },
      { time: '2026110301', value: 300, yValue: 300, count: 20 }
    ]);
  });

  test('ヒット数選択: value はヒット数、yValue は応答時間のまま', () => {
    const r = combineHeatmapData(time, count, [], 'service_count');
    assert.deepEqual([r[0].value, r[0].yValue, r[0].count], [10, 200, 10]);
  });

  test('エラー率: エラー件数/ヒット数、ヒット 0 件は 0%', () => {
    const r = combineHeatmapData(time, [d('2026110300', 10)], [d('2026110300', 1), d('2026110301', 5)], 'err_rate');
    assert.deepEqual([r[0].value, r[1].value], [10, 0]);
  });

  test('件数の系列に欠けがあっても別の時刻の値と混ざらない (回帰: インデックスずれ)', () => {
    // 先頭の時刻の件数が欠測。インデックスで突き合わせると 2 番目の件数が先頭に付いてしまう
    const r = combineHeatmapData(time, [d('2026110301', 20)], [], 'service_time');
    assert.deepEqual(r.map((x) => x.count), [0, 20]);
  });
});

describe('buildDayHourMap', () => {
  test('時刻は time の HH から求める (回帰: 欠測があるとセルがずれていた)', () => {
    // 2026-11-03 は火曜(2)。00 時と 05 時だけ存在する
    const map = buildDayHourMap([
      { time: '2026110300', value: 10, count: 1 },
      { time: '2026110305', value: 50, count: 1 }
    ]);
    assert.equal(map[2][0].count, 1);
    assert.equal(map[2][5].count, 1);
    assert.equal(map[2][1].count, 0); // 順序で割り当てると 5 時のデータが 1 時に入ってしまう
  });

  test('同じ曜日×時間は平均を取れるよう合算される', () => {
    const map = buildDayHourMap([
      { time: '2026110310', value: 10, count: 1 },
      { time: '2026111010', value: 30, count: 1 } // 翌週の火曜
    ]);
    assert.equal(map[2][10].sum, 40);
    assert.equal(map[2][10].count, 2);
    assert.equal(map[2][10].data.length, 2);
  });

  test('count が 0 の項目は集計しない', () => {
    const map = buildDayHourMap([{ time: '2026110310', value: 10, count: 0 }]);
    assert.equal(map[2][10].count, 0);
  });

  test('HH が取れない形式は日内の順序で代用する', () => {
    const map = buildDayHourMap([{ time: '20261103', value: 1, count: 1 }, { time: '20261103', value: 2, count: 1 }]);
    assert.equal(map[2][0].count, 1);
    assert.equal(map[2][1].count, 1);
  });

  test('cellAverage: weighted=true ならリクエスト数で加重、既定は単純平均', () => {
    // 同じ曜日×時間の 2 回の観測: 応答時間 100ms (1 件) と 300ms (3 件)
    const map = buildDayHourMap([
      { time: '2026110310', value: 100, count: 1 },
      { time: '2026111010', value: 300, count: 3 }
    ]);
    assert.equal(cellAverage(map[2][10]), 200);
    assert.equal(cellAverage(map[2][10], true), 250);
    assert.equal(cellAverage(map[2][11], true), 0); // データなし
  });

  test('dayHourAverages: weighted を渡すと加重した平均の配列になる', () => {
    const map = buildDayHourMap([
      { time: '2026110310', value: 100, count: 1 },
      { time: '2026111010', value: 300, count: 3 }
    ]);
    assert.deepEqual(dayHourAverages(map), [200]);
    assert.deepEqual(dayHourAverages(map, true), [250]);
  });

  test('dayHourAverages は有効セルの平均だけを返す', () => {
    const map = buildDayHourMap([{ time: '2026110310', value: 10, count: 1 }, { time: '2026111010', value: 30, count: 1 }]);
    assert.deepEqual(dayHourAverages(map), [20]);
  });
});

describe('computeIqrThresholds / median', () => {
  test('IQR 法: good=Q3, warning=Q3+1.5*IQR (入力順は問わない)', () => {
    // sorted: 10,20,30,40,50 -> Q1=20, Q3=40, IQR=20
    const t = computeIqrThresholds([50, 10, 40, 20, 30]);
    assert.deepEqual(t, { good: 40, warning: 70 });
  });

  test('データなしは null', () => {
    assert.equal(computeIqrThresholds([]), null);
  });

  test('入力配列を破壊しない', () => {
    const input = [3, 1, 2];
    computeIqrThresholds(input);
    assert.deepEqual(input, [3, 1, 2]);
  });

  test('median', () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
});

describe('computeOverallStats', () => {
  test('件数 0 の項目を除外して中央値と最大値を求める', () => {
    const s = computeOverallStats([
      { count: 10, yValue: 100 }, { count: 20, yValue: 300 }, { count: 30, yValue: 200 }, { count: 0, yValue: 99999 }
    ]);
    assert.deepEqual(s, { medianX: 20, maxX: 30, medianY: 200, maxY: 300 });
  });

  test('maxY は最低 100、maxX は最低 1', () => {
    const s = computeOverallStats([{ count: 0.5, yValue: 5 }]);
    assert.equal(s.maxY, 100);
    assert.equal(s.maxX, 1);
  });

  test('有効データなしは null', () => {
    assert.equal(computeOverallStats([]), null);
    assert.equal(computeOverallStats([{ count: 0, yValue: 1 }]), null);
  });
});
