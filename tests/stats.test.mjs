// PD 統計エンジンのテスト (Node 組み込みテストランナー: node --test)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { PD_CONFIG: {}, location: { origin: 'http://localhost' } };
const st = await import('../src/pd/stats.js');

const rows = (list) => list.map(([app, rt, extra = {}]) => ({ applicationName: app, responseTime: rt, ...extra }));
const makeStore = (list) => { const s = new st.TxStore(); s.push(rows(list)); return s; };

describe('percentile / summarize', () => {
  const sorted = Float64Array.from([10, 20, 30, 40, 50]);

  test('線形補間のパーセンタイル', () => {
    assert.equal(st.percentile(sorted, 0), 10);
    assert.equal(st.percentile(sorted, 50), 30);
    assert.equal(st.percentile(sorted, 100), 50);
    assert.equal(st.percentile(sorted, 25), 20);
    assert.equal(st.percentile(sorted, 90), 46);
  });

  test('空・1 件の境界', () => {
    assert.ok(Number.isNaN(st.percentile(new Float64Array(0), 50)));
    assert.equal(st.percentile(Float64Array.from([7]), 99), 7);
  });

  test('要約統計とエラー率', () => {
    const store = makeStore([['a', 10], ['a', 20, { errorType: 'E' }], ['b', 30], ['b', 40]]);
    const idx = st.filterIndices(store);
    const sum = st.summarize(store, idx, st.sortedResponseTimes(store, idx));
    assert.equal(sum.count, 4);
    assert.equal(sum.mean, 25);
    assert.equal(sum.max, 40);
    assert.equal(sum.errorCount, 1);
    assert.equal(sum.errorRate, 25);
  });
});

describe('filterIndices', () => {
  const store = makeStore([
    ['/api/user', 10], ['/api/user/profile', 20], ['/api/userX', 30], ['', 40],
    ['/api/order', 50, { errorType: 'ServiceException' }]
  ]);

  test('キーワードは部分一致 (大文字小文字を区別しない)', () => {
    assert.equal(st.filterIndices(store, { appKeyword: '/API/USER' }).length, 3);
  });

  test('appExact は完全一致 (回帰: ドリルダウンで別アプリが混ざっていた)', () => {
    assert.equal(st.filterIndices(store, { appExact: '/api/user' }).length, 1);
    assert.equal(st.filterIndices(store, { appExact: '' }).length, 1); // 名前が空のアプリ
  });

  test('エラー絞り込み', () => {
    assert.equal(st.filterIndices(store, { errorMode: 'error' }).length, 1);
    assert.equal(st.filterIndices(store, { errorMode: 'normal' }).length, 4);
  });

  test('応答時間の範囲', () => {
    assert.equal(st.filterIndices(store, { rtMin: 20, rtMax: 40 }).length, 3);
  });

  test('ビジネス ID はクライアント側で絞り込む', () => {
    const s = makeStore([['a', 1, { businessId: [1, 2] }], ['b', 2, { businessId: [3] }], ['c', 3, {}]]);
    assert.equal(st.filterIndices(s, { businessId: 2 }).length, 1);
    assert.equal(st.filterIndices(s, { businessId: '' }).length, 3);
  });
});

describe('TxStore', () => {
  test('初期容量を超えても拡張される', () => {
    const s = new st.TxStore();
    const many = Array.from({ length: 70000 }, (_, i) => ({ responseTime: i, applicationName: 'a' }));
    s.push(many);
    assert.equal(s.length, 70000);
    assert.equal(s.responseTime[69999], 69999);
  });

  test('数値でない応答時間の行は取り込まない', () => {
    const s = makeStore([['a', 1], ['a', NaN], ['a', 'x']]);
    assert.equal(s.length, 1);
  });
});

describe('buildHistogram', () => {
  test('自動モードは 50ms 幅で、最低 4 ビンを確保する', () => {
    const h = st.buildHistogram(Float64Array.from([1, 2, 3]), { mode: 'auto' });
    assert.equal(h.binWidth, 50);
    assert.ok(h.counts.length >= 4);
    assert.equal(h.counts.reduce((a, b) => a + b, 0) + h.overflowCount, 3);
  });

  test('全件がいずれかのビンか overflow に入る', () => {
    const data = Float64Array.from({ length: 1000 }, (_, i) => (i * 37) % 900);
    data.sort();
    const h = st.buildHistogram(data, { mode: 'auto' });
    assert.equal(h.counts.reduce((a, b) => a + b, 0) + h.overflowCount, 1000);
  });

  test('手動モード: 通常の指定はそのまま使う', () => {
    const h = st.buildHistogram(Float64Array.from([10, 60, 120]), { mode: 'manual', binWidth: 50, xMax: 200 });
    assert.deepEqual([h.binWidth, h.counts.length, h.counts.join()], [50, 4, '1,1,1,0']);
  });

  test('手動モード: ビン数に上限がある (回帰: 5 千万ビンで UI が止まっていた)', () => {
    const t0 = Date.now();
    const h = st.buildHistogram(Float64Array.from([1, 2, 3]), { mode: 'manual', binWidth: 1, xMax: 5e7 });
    assert.ok(h.counts.length <= 1000);
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(h.counts.reduce((a, b) => a + b, 0) + h.overflowCount, 3);
  });

  test('空データ', () => {
    const h = st.buildHistogram(new Float64Array(0));
    assert.equal(h.total, 0);
  });

  test('比較用: 同じビン境界に当てはめても総数は保たれる', () => {
    const ref = st.buildHistogram(Float64Array.from([10, 60, 120, 5000]), { mode: 'auto' });
    const cmp = st.applyHistogramEdges(Float64Array.from([5, 55, 65, 999999]), ref);
    assert.equal(cmp.counts.reduce((a, b) => a + b, 0) + cmp.overflowCount, 4);
  });

  test('ログビンも全件を数える', () => {
    const data = Float64Array.from([1, 5, 50, 500, 5000, 50000]);
    const h = st.buildHistogram(data, { mode: 'log' });
    assert.equal(h.counts.reduce((a, b) => a + b, 0) + h.overflowCount, 6);
  });
});

describe('appRanking', () => {
  test('P99 の降順で、標本数が少ないアプリは除外する', () => {
    const list = [];
    for (let i = 0; i < 10; i++) list.push(['/slow', 100 + i], ['/fast', 10 + i]);
    list.push(['/rare', 99999]); // 1 件だけ → minSamples 未満
    const store = makeStore(list);
    const ranking = st.appRanking(store, st.filterIndices(store));
    assert.deepEqual(ranking.map((r) => r.name), ['/slow', '/fast']);
  });
});
