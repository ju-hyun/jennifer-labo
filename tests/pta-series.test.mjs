// PTA 時系列処理のテスト
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSeries, flattenSorted, computeErrRate, calculateSMA,
  computeMonthlyAverages, averageValid, sliceRange, summarizeRange
} from '../src/pta/lib/series.js';

const d = (time, value) => ({ time, value });

describe('mergeSeries / flattenSorted', () => {
  test('結合して time 昇順にし、同じ time は先勝ちで重複を除く', () => {
    const merged = mergeSeries([[d('20260102', 2), d('20260101', 1)], [d('20260102', 99), d('20260103', 3)]]);
    assert.deepEqual(merged.map((x) => x.time), ['20260101', '20260102', '20260103']);
    assert.equal(merged[1].value, 2);
  });

  test('flattenSorted は重複を除かない', () => {
    const out = flattenSorted([[d('b', 1)], [d('a', 2), d('b', 3)]]);
    assert.deepEqual(out.map((x) => x.time), ['a', 'b', 'b']);
  });

  test('空入力', () => {
    assert.deepEqual(mergeSeries([]), []);
    assert.deepEqual(mergeSeries([[], []]), []);
  });
});

describe('computeErrRate', () => {
  test('time で突き合わせてエラー率(%)を出す。0 件の日は null (回帰: インデックスずれ)', () => {
    const count = [d('1', 100), d('2', 0), d('3', 50)];
    // 2 日目のエラー件数が欠測でも、3 日目が別の日の値と混ざらない
    const err = [d('1', 5), d('3', 25)];
    assert.deepEqual(computeErrRate(count, err), [d('1', 5), d('2', null), d('3', 50)]);
  });

  test('エラー件数の系列に欠けがあっても、対応する日は 0% になる', () => {
    assert.deepEqual(computeErrRate([d('1', 10), d('2', 10)], [d('2', 1)]), [d('1', 0), d('2', 10)]);
  });
});

describe('calculateSMA', () => {
  test('先頭の period-1 件は null、以降は直近 period 件の平均', () => {
    assert.deepEqual(calculateSMA([1, 2, 3, 4], 3), [null, null, 2, 3]);
  });
  test('欠測値は 0 として扱う', () => {
    assert.deepEqual(calculateSMA([3, null, 3], 3), [null, null, 2]);
  });
  test('データが period より短い', () => {
    assert.deepEqual(calculateSMA([1, 2], 7), [null, null]);
  });
});

describe('computeMonthlyAverages', () => {
  const todayStr = '20260310';

  test('月別平均と前月比 (最終月は同日数どうしで比較)', () => {
    const data = [
      d('20260101', 100), d('20260102', 100), d('20260103', 100), d('20260104', 100),
      d('20260201', 200), d('20260202', 200),
      d('20260301', 300), d('20260302', 500)
    ];
    const r = computeMonthlyAverages(data, { metric: 'service_time', todayStr });
    assert.equal(r['01'].avg, 100);
    assert.equal(r['01'].rate, null);          // 比較対象の月がない
    assert.equal(r['02'].avg, 200);
    assert.equal(r['02'].rate, 100);           // (200-100)/100
    assert.equal(r['03'].avg, 400);
    // 最終月は 2 日分 → 前月の月初から 2 日分 (200,200) と比較: (400-200)/200
    assert.equal(r['03'].rate, 100);
  });

  test('今日より未来の日(ゼロ埋め)は平均に含めない', () => {
    const r = computeMonthlyAverages([d('20260301', 10), d('20260320', 0), d('20260325', 999)], { metric: 'service_time', todayStr });
    assert.equal(r['03'].avg, 10);
  });

  test('0 は通常の指標では除外するが、err_rate では 0% を残す (回帰: 平均エラー率が過大だった)', () => {
    const data = [d('20260301', 0), d('20260302', 10)];
    assert.equal(computeMonthlyAverages(data, { metric: 'service_time', todayStr })['03'].avg, 10);
    assert.equal(computeMonthlyAverages(data, { metric: 'err_rate', todayStr })['03'].avg, 5);
  });

  test('null(欠測)は除外する', () => {
    const r = computeMonthlyAverages([d('20260301', null), d('20260302', 4)], { metric: 'err_rate', todayStr });
    assert.equal(r['03'].avg, 4);
  });

  test('有効データのない月は avg 0', () => {
    const r = computeMonthlyAverages([d('20260201', 5), d('20260301', 0)], { metric: 'service_time', todayStr });
    assert.equal(r['03'].avg, 0);
    // 前月平均 5 > 0 なので前月比は (0-5)/5 = -100%
    assert.equal(r['03'].rate, -100);
  });

  test('前月平均が 0 のとき前月比は 0 (0 除算しない)', () => {
    const r = computeMonthlyAverages([d('20260201', 0), d('20260301', 7)], { metric: 'service_time', todayStr });
    assert.equal(r['03'].rate, 0);
  });

  test('空データ', () => {
    assert.deepEqual(computeMonthlyAverages([], { metric: 'service_time', todayStr }), {});
  });
});

describe('averageValid / sliceRange', () => {
  test('0・null・未来日を除いて平均する', () => {
    const data = [d('20260101', 10), d('20260102', 0), d('20260103', null), d('20260104', 30), d('20260201', 999)];
    assert.equal(averageValid(data, '20260131'), 20);
  });
  test('keepZero なら 0 も平均に含める', () => {
    assert.equal(averageValid([d('1', 0), d('2', 10)], '9', true), 5);
  });
  test('有効データなしは 0', () => {
    assert.equal(averageValid([], '9'), 0);
  });
  test('sliceRange は範囲外を丸める', () => {
    assert.deepEqual(sliceRange([1, 2, 3, 4], -5, 10), [1, 2, 3, 4]);
    assert.deepEqual(sliceRange([1, 2, 3, 4], 1, 2), [2, 3]);
    assert.deepEqual(sliceRange([], 0, 3), []);
    assert.deepEqual(sliceRange(undefined, 0, 3), []);
  });
});

describe('summarizeRange', () => {
  const yearly = {
    service_time: [d('20260101', 100), d('20260102', 300)],
    service_rate: [d('20260101', 2), d('20260102', 4)],
    concurrent_user: [d('20260101', 10), d('20260102', 20)],
    service_count: [d('20260101', 1000), d('20260102', 3000)],
    sys_cpu: [], heap_usage: [],
    err_rate: [d('20260101', 0), d('20260102', 10)]
  };
  const opts = { metric: 'service_time', todayStr: '20260110' };

  test('平均・ピーク日・エラー率(0% を含む)', () => {
    const s = summarizeRange(yearly, 0, 1, opts);
    assert.equal(s.avgResponseTime, 200);
    assert.equal(s.avgTps, 3);
    assert.equal(s.avgConcurrentUsers, 15);
    assert.equal(s.avgHits, 2000);
    assert.equal(s.avgErrRate, 5);
    assert.equal(s.peakDate, '2026-01-02');
    assert.equal(s.avgSysCpu, 0);
  });

  test('範囲を絞ると、その範囲だけで計算する', () => {
    assert.equal(summarizeRange(yearly, 0, 0, opts).avgResponseTime, 100);
  });

  test('データなし/不正範囲は null', () => {
    assert.equal(summarizeRange(yearly, -1, 1, opts), null);
    assert.equal(summarizeRange({ ...yearly, service_time: [] }, 0, 1, opts), null);
  });
});
