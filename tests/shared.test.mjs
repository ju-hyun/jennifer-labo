// PTA / PD 共通モジュールのテスト
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, getJson, isUnauthorized } from '../src/shared/http.js';
import { escapeHtml } from '../src/shared/html.js';
import { percentile } from '../src/shared/percentile.js';
import { buildDomainTree, findFirstDomain } from '../src/shared/domain-tree.js';

describe('getJson', () => {
  beforeEach(() => { globalThis.fetch = undefined; });

  test('成功時は JSON を返し、GET + Accept ヘッダで呼ぶ', async () => {
    let seen;
    globalThis.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ result: [1] }) }; };
    assert.deepEqual(await getJson(new URL('http://x/api/domain?a=1')), { result: [1] });
    assert.equal(seen.url, 'http://x/api/domain?a=1');
    assert.equal(seen.init.method, 'GET');
    assert.equal(seen.init.headers.Accept, 'application/json');
  });

  test('401 は status 401 の ApiError', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401 });
    await assert.rejects(getJson('http://x'), (e) => e instanceof ApiError && e.status === 401 && isUnauthorized(e));
  });

  test('その他のエラーステータスは ApiError (401 ではない)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(getJson('http://x'), (e) => e instanceof ApiError && e.status === 503 && e.message === 'HTTP Error: 503' && !isUnauthorized(e));
  });

  test('ネットワーク障害はそのまま投げる (ApiError ではない)', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(getJson('http://x'), (e) => e instanceof TypeError && !isUnauthorized(e));
  });

  test('AbortSignal を fetch に渡す', async () => {
    let signal;
    globalThis.fetch = async (_u, init) => { signal = init.signal; return { ok: true, status: 200, json: async () => ({}) }; };
    const ac = new AbortController();
    await getJson('http://x', { signal: ac.signal });
    assert.equal(signal, ac.signal);
  });
});

describe('escapeHtml', () => {
  test('HTML の特殊文字をエスケープする', () => {
    assert.equal(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  });
  test('数値などは文字列化する', () => {
    assert.equal(escapeHtml(123), '123');
    assert.equal(escapeHtml(null), 'null');
  });
});

describe('percentile', () => {
  const sorted = [10, 20, 30, 40, 50];
  test('線形補間', () => {
    assert.equal(percentile(sorted, 0), 10);
    assert.equal(percentile(sorted, 25), 20);
    assert.equal(percentile(sorted, 50), 30);
    assert.equal(percentile(sorted, 90), 46);
    assert.equal(percentile(sorted, 100), 50);
  });
  test('境界: 空は NaN、1 件はその値', () => {
    assert.ok(Number.isNaN(percentile([], 50)));
    assert.equal(percentile([7], 99), 7);
  });
  test('TypedArray でも使える', () => {
    assert.equal(percentile(Float64Array.from([1, 2, 3]), 50), 2);
  });
  test('PTA が以前使っていた 0〜1 の分位数式と同じ値になる (統合前後で数値が変わらないこと)', () => {
    const old = (arr, p) => { // 統合前の PTA の実装
      if (arr.length === 0) return 0;
      if (p <= 0) return arr[0];
      if (p >= 1) return arr[arr.length - 1];
      const index = (arr.length - 1) * p; const lower = Math.floor(index); const upper = lower + 1; const weight = index % 1;
      if (upper >= arr.length) return arr[lower];
      return arr[lower] * (1 - weight) + arr[upper] * weight;
    };
    let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let n = 0; n < 500; n++) {
      const arr = Array.from({ length: 1 + Math.floor(rnd() * 200) }, () => rnd() * 10000).sort((a, b) => a - b);
      for (const p of [0.25, 0.75]) {
        assert.ok(Math.abs(old(arr, p) - percentile(arr, p * 100)) < 1e-9, `p=${p} n=${arr.length}`);
      }
    }
  });
});

describe('buildDomainTree / findFirstDomain', () => {
  const flat = [
    { domainId: 1000, name: 'A', groupHierarchy: ['G1', 'G2'] },
    { domainId: 1001, name: 'B', groupHierarchy: ['G1', 'G2'] },
    { domainId: 1002, name: 'C', groupHierarchy: ['G3'] },
    { domainId: 1003, name: 'NoGroup' },
    { domainId: 1004, name: 'EmptyGroup', groupHierarchy: [] }
  ];
  const tree = buildDomainTree(flat);

  test('グループ階層をたどってドメインを配置する (id は文字列)', () => {
    const g2 = tree.find((n) => n.name === 'G1').children.find((n) => n.name === 'G2');
    assert.deepEqual(g2.children.map((c) => [c.type, c.id, c.name]), [['domain', '1000', 'A'], ['domain', '1001', 'B']]);
  });

  test('同名グループは 1 つにまとまる', () => {
    assert.equal(tree.filter((n) => n.name === 'G1').length, 1);
  });

  test('グループ指定なし・空配列は「未分類ドメイン」に入る', () => {
    const none = tree.find((n) => n.name === '未分類ドメイン');
    assert.deepEqual(none.children.map((c) => c.name), ['NoGroup', 'EmptyGroup']);
  });

  test('findFirstDomain は最初のドメインまでのパスを返す', () => {
    const found = findFirstDomain(tree);
    assert.deepEqual(found.path.map((n) => n.name), ['G1', 'G2', 'A']);
    assert.equal(found.node.id, '1000');
  });

  test('部分木からも探せる / 見つからなければ null', () => {
    const g3 = tree.find((n) => n.name === 'G3');
    assert.equal(findFirstDomain(g3.children, [g3]).node.name, 'C');
    assert.equal(findFirstDomain([]), null);
    assert.equal(findFirstDomain([{ type: 'group', name: 'empty', children: [] }]), null);
  });
});
