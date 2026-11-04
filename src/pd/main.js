/**
 * 応答時間パーセンタイル分布分析 (Percentile Distribution / PD)
 *
 * エントリポイント。初期化のみを担当し、処理は各モジュールに委譲する。
 * 通信は api.js、統計は stats.js、描画は chart.js / panel.js / view.js に置く。
 */
import { TIMEZONE_LABEL } from './config.js';
import { el } from './dom.js';
import { charts, state } from './state.js';
import { setPreset } from './range.js';
import { loadDomains } from './targets.js';
import { recompute } from './view.js';
import { bindEvents } from './events.js';

// 開発時のみ、ブラウザコンソールから状態を覗けるようにする
if (import.meta.env?.DEV) {
  window.__pd = { state, charts };
}

async function init() {
  if (!window.PD_CONFIG) {
    console.warn('PD_CONFIG が未設定です。config.js が読み込まれているか確認してください (public/pd/config.js)。');
  }

  // 照会期間は JENNIFER サーバの時間帯で指定する (config.js の TIMEZONE)。何の時刻か分かるよう表示する
  if (TIMEZONE_LABEL) {
    el.tzLabel.textContent = TIMEZONE_LABEL;
    el.tzLabel.classList.remove('hidden');
  }

  state.activePreset = 15;
  setPreset(state.activePreset);
  bindEvents();
  recompute({ quiet: true });
  await loadDomains();
}

init();
