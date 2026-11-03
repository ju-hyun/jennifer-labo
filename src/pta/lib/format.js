/**
 * PTA の純粋なフォーマット関数 (DOM・グローバル状態に依存しない)
 */

/** API の time_pattern=yyyyMMddHH 用 (ローカル時刻) */
export function formatDateParam(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  return `${y}${m}${d}${h}`;
}

/** Date -> "yyyyMMdd" (ローカル時刻)。API の time 文字列との文字列比較に使う */
export function toYMD(date) {
  return date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0');
}

export function getMetricUnit(metric) {
  switch (metric) {
    case 'service_time': return 'ms';
    case 'service_rate': return 'TPS';
    case 'concurrent_user': return '人';
    case 'service_count': return 'Hits';
    case 'sys_cpu':
    case 'max_sys_cpu':
    case 'heap_usage':
    case 'err_rate': return '%';
    default: return '';
  }
}

/** "yyyyMMdd..." -> "yyyy.MM.dd" */
export function formatYMDLocal(str) {
  const y = str.substring(0, 4);
  const m = str.substring(4, 6);
  const d = str.substring(6, 8);
  return `${y}.${m}.${d}`;
}

/** "yyyyMMdd..." -> "MM/dd" (full=true なら "yyyy-MM-dd")。短すぎる入力はそのまま返す */
export function parseDateString(dateStr, full = false) {
  if (!dateStr || dateStr.length < 8) return dateStr;
  const y = dateStr.substring(0, 4);
  const m = dateStr.substring(4, 6);
  const d = dateStr.substring(6, 8);
  if (full) return `${y}-${m}-${d}`;
  return `${m}/${d}`;
}
