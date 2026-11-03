/**
 * PD の画面全体で共有する状態とチャートインスタンス
 */
import { TxStore } from './stats.js';

export const state = {
  domainTree: [],
  selectedPath: [],          // [{ id, name, type }]
  targetType: 'instance',
  instanceId: '',
  businessId: '',
  store: new TxStore(),
  indices: null,
  sorted: null,
  summary: null,
  histogram: null,
  collecting: false,
  abortController: null,
  lastRange: null,
  drilldownApp: null,
  snapshot: null,     // 比較モード用の前回照会スナップショット
  activePreset: null, // 選択中のプリセット(分)。手入力した時は null
  targetsSeq: 0       // loadTargets の連続呼び出しで古い応答を捨てるための世代番号
};

export const charts = { histogram: null, cdf: null, ranking: null };
