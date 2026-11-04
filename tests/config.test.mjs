// 配布する実行時設定 (public/*/config.js) が正しく評価でき、必要な項目を持つことの確認
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { setTimeZone } from '../src/shared/tz.js';

function load(app) {
  const code = fs.readFileSync(new URL(`../public/${app}/config.js`, import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(code, { window }); // 構文エラーなら例外になる
  return window;
}

describe('public/*/config.js', () => {
  test('PTA: 評価でき、API_DOMAIN と TIMEZONE を持つ', () => {
    const cfg = load('pta').PTA_CONFIG;
    assert.equal(cfg.API_DOMAIN, '');
    assert.equal(typeof cfg.TIMEZONE, 'string');
  });

  test('PD: 評価でき、収集設定と TIMEZONE を持つ', () => {
    const cfg = load('pd').PD_CONFIG;
    assert.equal(cfg.API_DOMAIN, '');
    assert.equal(typeof cfg.TIMEZONE, 'string');
    assert.ok(cfg.CHUNK_WAIT_MS >= 0 && cfg.MAX_POINTS > 0 && cfg.CONFIRM_CHUNKS > 0);
  });

  test('配布する TIMEZONE は Intl が認識する有効な時間帯名', () => {
    for (const app of ['pta', 'pd']) {
      const cfg = load(app)[app === 'pta' ? 'PTA_CONFIG' : 'PD_CONFIG'];
      assert.equal(setTimeZone(cfg.TIMEZONE), cfg.TIMEZONE, `${app}: ${cfg.TIMEZONE}`);
    }
    setTimeZone(null);
  });

  test('トークンなど秘密情報を含めない', () => {
    for (const app of ['pta', 'pd']) {
      const text = fs.readFileSync(new URL(`../public/${app}/config.js`, import.meta.url), 'utf8');
      assert.doesNotMatch(text, /^\s*token\s*:/im);
    }
  });
});
