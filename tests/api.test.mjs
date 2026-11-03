// PD API 層のテスト (Node 組み込みテストランナー: node --test)
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// api.js はモジュール読み込み時に window.PD_CONFIG を参照するため、先にスタブを用意する
globalThis.window = { PD_CONFIG: {}, location: { origin: 'http://localhost' } };
const api = await import('../src/pd/api.js');

const okJson = (result) => ({ ok: true, status: 200, json: async () => ({ result }) });
const MIN = 60 * 1000;

describe('時刻変換', () => {
  test('formatApiTime / parseApiTime は相互変換できる', () => {
    const d = new Date(2026, 10, 3, 9, 5, 7); // ローカル時刻
    const s = api.formatApiTime(d);
    assert.equal(s, '20261103090507');
    assert.equal(api.parseApiTime(s).getTime(), d.getTime());
  });

  test('不正な値は null', () => {
    assert.equal(api.parseApiTime(null), null);
    assert.equal(api.parseApiTime('abc'), null);
  });
});

describe('buildChunks', () => {
  test('最大 1 分に分割し、端数は最後のチャンクだけ短くなる', () => {
    const start = new Date(0);
    const chunks = api.buildChunks(start, new Date(150 * 1000));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].end.getTime() - chunks[0].start.getTime(), MIN);
    assert.equal(chunks[2].end.getTime() - chunks[2].start.getTime(), 30 * 1000);
    // 隙間も重なりもない
    chunks.slice(1).forEach((c, i) => assert.equal(c.start.getTime(), chunks[i].end.getTime()));
  });

  test('空の期間は 0 件', () => {
    assert.equal(api.buildChunks(new Date(1000), new Date(1000)).length, 0);
  });
});

describe('collectTransactions', () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  test('全チャンクを順に収集する', async () => {
    globalThis.fetch = async () => okJson([{ responseTime: 5 }]);
    const r = await api.collectTransactions({ domainId: 1, startDate: new Date(0), endDate: new Date(2 * MIN) });
    assert.deepEqual([r.chunks, r.total, r.failed, r.aborted], [2, 2, 0, false]);
  });

  test('失敗しても再試行して成功すれば failed に数えない', async () => {
    let n = 0;
    globalThis.fetch = async () => (++n < 2 ? { ok: false, status: 500 } : okJson([{ responseTime: 1 }]));
    const r = await api.collectTransactions({ domainId: 1, startDate: new Date(0), endDate: new Date(MIN) });
    assert.deepEqual([r.total, r.failed], [1, 0]);
  });

  test('リトライ待機中に中断しても例外にならず aborted になる (回帰: AbortError が外へ漏れていた)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await api.collectTransactions({ domainId: 1, startDate: new Date(0), endDate: new Date(MIN), signal: ac.signal });
    assert.equal(r.aborted, true);
  });

  test('401 は即座に ApiError を投げる', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(
      api.collectTransactions({ domainId: 1, startDate: new Date(0), endDate: new Date(MIN) }),
      (e) => e instanceof api.ApiError && e.status === 401
    );
  });

  test('上限件数に達したら打ち切る', async () => {
    globalThis.fetch = async () => okJson([{ responseTime: 1 }, { responseTime: 2 }]);
    const r = await api.collectTransactions({
      domainId: 1, startDate: new Date(0), endDate: new Date(10 * MIN), maxPoints: 4
    });
    assert.equal(r.limitReached, true);
    assert.equal(r.total, 4);
  });

  test('instance_id・時刻・time_pattern をクエリに載せる', async () => {
    let url;
    globalThis.fetch = async (u) => { url = new URL(u); return okJson([]); };
    await api.collectTransactions({ domainId: 7, instanceIds: [3, 4], startDate: new Date(0), endDate: new Date(MIN) });
    assert.equal(url.pathname, '/api/transaction/time');
    assert.equal(url.searchParams.get('domain_id'), '7');
    assert.equal(url.searchParams.get('instance_id'), '3,4');
    assert.equal(url.searchParams.get('time_pattern'), 'yyyyMMddHHmmss');
  });
});
