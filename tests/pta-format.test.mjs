// PTA フォーマット関数のテスト
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatDateParam, toYMD, getMetricUnit, escapeHtml, formatYMDLocal, parseDateString } from '../src/pta/lib/format.js';

describe('日付フォーマット', () => {
  test('formatDateParam は yyyyMMddHH (ローカル時刻・ゼロ埋め)', () => {
    assert.equal(formatDateParam(new Date(2026, 0, 5, 3)), '2026010503');
    assert.equal(formatDateParam(new Date(2026, 10, 30, 23, 59)), '2026113023');
  });

  test('toYMD は yyyyMMdd', () => {
    assert.equal(toYMD(new Date(2026, 1, 3)), '20260203');
  });

  test('parseDateString は MM/dd、full なら yyyy-MM-dd、短い入力はそのまま', () => {
    assert.equal(parseDateString('2026110300'), '11/03');
    assert.equal(parseDateString('20261103', true), '2026-11-03');
    assert.equal(parseDateString('2026'), '2026');
    assert.equal(parseDateString(''), '');
    assert.equal(parseDateString(undefined), undefined);
  });

  test('formatYMDLocal は yyyy.MM.dd', () => {
    assert.equal(formatYMDLocal('2026110300'), '2026.11.03');
  });
});

describe('getMetricUnit', () => {
  test('指標ごとの単位', () => {
    assert.equal(getMetricUnit('service_time'), 'ms');
    assert.equal(getMetricUnit('service_rate'), 'TPS');
    assert.equal(getMetricUnit('service_count'), 'Hits');
    assert.equal(getMetricUnit('concurrent_user'), '人');
    for (const m of ['sys_cpu', 'max_sys_cpu', 'heap_usage', 'err_rate']) assert.equal(getMetricUnit(m), '%');
    assert.equal(getMetricUnit('unknown'), '');
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
