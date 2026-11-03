/**
 * PTA の画面全体で共有する状態。
 * 以前は main.js のモジュール変数だったもの。分割後は各モジュールが同じオブジェクトを参照する。
 */
export const state = {
  // メインチャート
  mainChartInstance: null,
  currentChartType: 'line',
  showMA: true,
  currentMetric: 'service_time',

  // 1 年分の日次データ (指標名 -> [{ time, value }])
  yearlyData: {
    service_time: [],
    service_rate: [],
    concurrent_user: [],
    service_count: [],
    sys_cpu: [],
    heap_usage: [],
    max_sys_cpu: [],
    service_err_count: [],
    err_rate: []
  },

  // チャートの期間選択
  selectedStartMonth: null,
  selectedEndMonth: null,
  isSelecting: false,
  dragStartX: null,
  dragCurrentX: null,
  activeSelectionBoundary: 'end', // 'start' | 'end'

  // ヒートマップの色分けしきい値 (期間を選び直しても保持する)
  metricThresholds: {},
  overallYThresholds: {},

  // ドメイン選択
  domainTree: [],
  currentSelectedPath: [] // [{ id: string, name: string, type: 'group' | 'domain' }]
};

/** 選択中のドメイン ID (ドメインが選ばれていなければ null) */
export function getCurrentDomainId() {
  const lastItem = state.currentSelectedPath[state.currentSelectedPath.length - 1];
  return (lastItem && lastItem.type === 'domain') ? lastItem.id : null;
}
