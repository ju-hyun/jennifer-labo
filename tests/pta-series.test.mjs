// PTA 時系列処理のテスト
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeSeries, flattenSorted, computeErrRate, calculateSMA,
  computeMonthlyAverages, averageValid, sliceRange, summarizeRange, isHitWeighted, weightMap
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

describe('加重平均 (averageValid / computeMonthlyAverages)', () => {
  const todayStr = '20260310';

  test('isHitWeighted: 応答時間とエラー率だけが対象', () => {
    assert.equal(isHitWeighted('service_time'), true);
    assert.equal(isHitWeighted('err_rate'), true);
    for (const m of ['service_rate', 'service_count', 'concurrent_user', 'sys_cpu', 'heap_usage']) assert.equal(isHitWeighted(m), false);
  });

  test('averageValid: weights を渡すと加重、渡さなければ従来どおり', () => {
    const data = [d('1', 10), d('2', 30)];
    assert.equal(averageValid(data, '9'), 20);
    assert.equal(averageValid(data, '9', false, weightMap([d('1', 1), d('2', 3)])), 25);
  });

  test('averageValid: 重みが 0 の日は影響しない。重みの合計が 0 なら単純平均', () => {
    assert.equal(averageValid([d('1', 10), d('2', 30)], '9', false, weightMap([d('1', 0), d('2', 5)])), 30);
    assert.equal(averageValid([d('1', 10), d('2', 30)], '9', false, weightMap([d('1', 0), d('2', 0)])), 20);
  });

  test('computeMonthlyAverages: weights で月平均を加重し、最終月の前月比も加重で比較する', () => {
    const data = [d('20260201', 100), d('20260202', 300), d('20260301', 100), d('20260302', 300)];
    const weights = weightMap([d('20260201', 1), d('20260202', 3), d('20260301', 3), d('20260302', 1)]);
    const r = computeMonthlyAverages(data, { metric: 'service_time', todayStr, weights });
    assert.equal(r['02'].avg, 250); // (100*1 + 300*3) / 4
    assert.equal(r['03'].avg, 150); // (100*3 + 300*1) / 4
    // 最終月は 2 日分 → 前月の月初 2 日分 (加重平均 250) と比較: (150-250)/250 = -40%
    assert.equal(r['03'].rate, -40);
  });

  test('computeMonthlyAverages: 重みが無い月は単純平均 (他の月は加重のまま)', () => {
    const data = [d('20260201', 100), d('20260202', 300), d('20260301', 100), d('20260302', 300)];
    const weights = weightMap([d('20260201', 1), d('20260202', 3)]); // 3 月分は欠測
    const r = computeMonthlyAverages(data, { metric: 'service_time', todayStr, weights });
    assert.equal(r['02'].avg, 250);
    assert.equal(r['03'].avg, 200);
  });

  test('computeMonthlyAverages: weights なしは従来と同じ結果', () => {
    const data = [d('20260201', 100), d('20260202', 300)];
    assert.deepEqual(
      computeMonthlyAverages(data, { metric: 'service_time', todayStr }),
      computeMonthlyAverages(data, { metric: 'service_time', todayStr, weights: null })
    );
    assert.equal(computeMonthlyAverages(data, { metric: 'service_time', todayStr })['02'].avg, 200);
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

  test('平均応答時間とエラー率はリクエスト数で加重する (閑散日と繁忙日を同じ重みにしない)', () => {
    const s = summarizeRange(yearly, 0, 1, opts);
    // 応答時間: (100*1000 + 300*3000) / 4000 = 250 (単純平均なら 200)
    assert.equal(s.avgResponseTime, 250);
    // エラー率: 日別 0% / 10% を 1000 / 3000 件で加重 = 7.5% (総エラー件数/総件数と一致)。単純平均なら 5%
    assert.equal(s.avgErrRate, 7.5);
  });

  test('TPS・同時ユーザ・ヒット数は単純平均、ピーク日も従来どおり', () => {
    const s = summarizeRange(yearly, 0, 1, opts);
    assert.equal(s.avgTps, 3);
    assert.equal(s.avgConcurrentUsers, 15);
    assert.equal(s.avgHits, 2000);
    assert.equal(s.peakDate, '2026-01-02');
    assert.equal(s.avgSysCpu, 0);
  });

  test('weighted:false なら従来の単純平均 (エラー率は 0% の日も含める)', () => {
    const s = summarizeRange(yearly, 0, 1, { ...opts, weighted: false });
    assert.equal(s.avgResponseTime, 200);
    assert.equal(s.avgErrRate, 5);
  });

  test('加重平均のエラー率は 総エラー件数 / 総リクエスト件数 と一致する', () => {
    const y = { ...yearly,
      service_count: [d('20260101', 200), d('20260102', 800)],
      err_rate: [d('20260101', 50), d('20260102', 5)] }; // 100 件 + 40 件のエラー
    const expected = (100 + 40) / (200 + 800) * 100;
    assert.ok(Math.abs(summarizeRange(y, 0, 1, opts).avgErrRate - expected) < 1e-9);
  });

  test('リクエスト数の系列が無い/欠けているときは単純平均に戻る (黙って日を捨てない)', () => {
    assert.equal(summarizeRange({ ...yearly, service_count: [] }, 0, 1, opts).avgResponseTime, 200);
    // 2 日目の件数だけ欠測: 重みが揃わないので全体を単純平均にする
    const partial = { ...yearly, service_count: [d('20260101', 1000)] };
    assert.equal(summarizeRange(partial, 0, 1, opts).avgResponseTime, 200);
  });

  test('範囲を絞ると、その範囲だけで計算する', () => {
    assert.equal(summarizeRange(yearly, 0, 0, opts).avgResponseTime, 100);
  });

  test('データなし/不正範囲は null', () => {
    assert.equal(summarizeRange(yearly, -1, 1, opts), null);
    assert.equal(summarizeRange({ ...yearly, service_time: [] }, 0, 1, opts), null);
  });
});
