/**
 * JENNIFER5 OpenAPI 呼び出し層
 *
 * 参照仕様: JENNIFER5マニュアル 付録 5.9 (OpenAPI)
 *   - 5.9.1.1 /api/domain
 *   - 5.9.1.2 /api/business
 *   - 5.9.1.3 /api/instance
 *   - 5.9.4.5 /api/transaction/time  ← 本システムの中核
 *
 * 認証トークンはクライアントに存在しない。/api/ へのリクエストが
 * リバースプロキシ(本番: nginx / ローカル: Vite dev proxy)を通る際に
 * サーバ側で token クエリが注入される。
 */

import { ApiError, getJson } from '../shared/http.js';
import { formatYMDHMS, wallToDate } from '../shared/tz.js';

// 既存の import 元 (main.js 等) を変えずに済むよう再エクスポートする
export { ApiError };

const PD_CFG = window.PD_CONFIG || {};
const API_ROOT = PD_CFG.API_DOMAIN || '';

export const DOMAIN_API = `${API_ROOT}/api/domain`;
export const INSTANCE_API = `${API_ROOT}/api/instance`;
export const BUSINESS_API = `${API_ROOT}/api/business`;
export const TRANSACTION_API = `${API_ROOT}/api/transaction/time`;

/** 付録 5.9.4.5:「照会時間範囲は最大1分まで」 */
export const CHUNK_MS = 60 * 1000;

/** time_pattern は常に明示送信する (§3.2.1 C7 — 既定値が原文で矛盾しているため) */
export const TIME_PATTERN = 'yyyyMMddHHmmss';

/** Date -> "yyyyMMddHHmmss" (サーバ時間帯 TIMEZONE の壁時計。未設定ならブラウザのローカル時刻) */
export function formatApiTime(date) {
  return formatYMDHMS(date);
}

/** "yyyyMMddHHmmss" / "yyyyMMddHHmm" / unix ms 文字列 -> Date (パース失敗時は null)。文字列はサーバ時間帯の壁時計として解釈する */
export function parseApiTime(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  // Unix timestamp (ms) — 13桁前後の数値で、年として解釈できない場合
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{3})?$/);
  if (!m) return null;
  // API が返す時刻文字列はサーバ時間帯の壁時計
  return wallToDate({
    y: Number(m[1]), m: Number(m[2]), d: Number(m[3]),
    h: Number(m[4]), mi: Number(m[5]), s: Number(m[6] || 0), ms: Number(m[7] || 0)
  });
}

function apiUrl(base, params = {}) {
  const url = new URL(base, window.location.origin);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.append(k, v);
  });
  return url;
}

/* ------------------------------------------------------------------ */
/* 対象リスト API                                                      */
/* ------------------------------------------------------------------ */

export async function fetchDomains() {
  const data = await getJson(apiUrl(DOMAIN_API));
  const list = data.result || [];
  return list.slice().sort((a, b) => a.domainId - b.domainId);
}

export async function fetchInstances(domainId) {
  if (!domainId) return [];
  const data = await getJson(apiUrl(INSTANCE_API, { domain_id: domainId }));
  const list = data.result || [];
  return list.slice().sort((a, b) => a.instanceId - b.instanceId);
}

export async function fetchBusinesses(domainId) {
  if (!domainId) return [];
  const data = await getJson(apiUrl(BUSINESS_API, { domain_id: domainId }));
  return data.result || [];
}

/* ------------------------------------------------------------------ */
/* X-View トランザクション (付録 5.9.4.5)                              */
/* ------------------------------------------------------------------ */

/**
 * 照会期間を「最大1分」のチャンクに分割する。
 * 端数は丸めず、最後のチャンクのみ実際の終了時刻を用いる。
 * @returns {{start: Date, end: Date}[]}
 */
export function buildChunks(startDate, endDate) {
  const chunks = [];
  let cursor = startDate.getTime();
  const endMs = endDate.getTime();
  while (cursor < endMs) {
    const next = Math.min(cursor + CHUNK_MS, endMs);
    chunks.push({ start: new Date(cursor), end: new Date(next) });
    cursor = next;
  }
  return chunks;
}

/** 1チャンク分の X-View 点データを取得する */
export async function fetchTransactionChunk({ domainId, instanceIds, start, end, signal }) {
  const url = apiUrl(TRANSACTION_API, {
    domain_id: domainId,
    // 付録 5.9.4.5: instance_id はカンマ区切りの配列。未指定でドメイン全インスタンス
    instance_id: instanceIds && instanceIds.length ? instanceIds.join(',') : undefined,
    start_time: formatApiTime(start),
    end_time: formatApiTime(end),
    time_pattern: TIME_PATTERN
  });
  const data = await getJson(url, { signal });
  return data.result || [];
}

/**
 * 隣り合うチャンクは境界の時刻を共有する (チャンク i の end_time = チャンク i+1 の start_time)。
 * API が境界時刻を両側で含む場合、境界上で終了したトランザクションが 2 回返されるため、
 * 直前のチャンクに既に含まれている txid の行を除く。txid はトランザクションごとに一意なので、
 * 境界が「含む」「含まない」のどちらの仕様でも結果は正しい。txid が無い行は判定できないので残す。
 *
 * @param {object[]} rows 今回のチャンクの行
 * @param {Set<string>} prevIds 直前のチャンクの txid 集合
 * @returns {{unique: object[], ids: Set<string>, duplicates: number}} ids は次のチャンクとの比較用
 */
export function dropBoundaryDuplicates(rows, prevIds) {
  const ids = new Set();
  const unique = [];
  let duplicates = 0;
  for (const row of rows) {
    const id = row?.txid;
    if (id !== undefined && id !== null && id !== '') {
      ids.add(id);
      if (prevIds.has(id)) {
        duplicates++;
        continue;
      }
    }
    unique.push(row);
  }
  return { unique, ids, duplicates };
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

const isAbort = (e) => e && (e.name === 'AbortError' || e.name === 'ApiAbort');

/**
 * 1分チャンクを逐次(同時実行数 1)で収集する。
 *
 * データサーバへの負荷を避けるため意図的に並列化していない
 * (付録 5.9.4.5:「X-View基本データの照会はデータサーバに負荷を与えます」)。
 *
 * @param {object}   opts
 * @param {number}   opts.domainId
 * @param {number[]} [opts.instanceIds]
 * @param {Date}     opts.startDate
 * @param {Date}     opts.endDate
 * @param {AbortSignal} [opts.signal]      中断用
 * @param {number}   [opts.waitMs]         チャンク間ウェイト
 * @param {number}   [opts.maxPoints]      累積件数の安全上限
 * @param {(rows:object[], info:object)=>void} opts.onChunk    チャンク取得ごと
 * @param {(info:object)=>void}                [opts.onProgress] 進捗更新ごと
 * @returns {Promise<{total:number, failed:number, chunks:number, aborted:boolean, limitReached:boolean, duplicates:number}>}
 */
export async function collectTransactions({
  domainId,
  instanceIds = [],
  startDate,
  endDate,
  signal,
  waitMs = PD_CFG.CHUNK_WAIT_MS ?? 0,
  maxPoints = PD_CFG.MAX_POINTS ?? 300000,
  onChunk,
  onProgress
}) {
  const chunks = buildChunks(startDate, endDate);
  const summary = {
    total: 0,
    failed: 0,
    chunks: chunks.length,
    done: 0,
    aborted: false,
    limitReached: false,
    duplicates: 0 // チャンク境界で重複していたため除外した件数
  };

  let prevIds = new Set(); // 直前のチャンクの txid (境界の重複除去用)

  const report = () => onProgress?.({ ...summary });

  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }

    const { start, end } = chunks[i];
    let rows = null;

    // 最大2回リトライ (指数バックオフ)。それでも失敗したらスキップして続行。
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        rows = await fetchTransactionChunk({ domainId, instanceIds, start, end, signal });
        break;
      } catch (err) {
        if (isAbort(err)) {
          summary.aborted = true;
          return summary;
        }
        if (err instanceof ApiError && err.status === 401) throw err; // 認証エラーは即時中断
        if (attempt === 2) {
          console.warn(`Chunk ${i + 1}/${chunks.length} failed after retries:`, err);
          summary.failed++;
        } else {
          try {
            await sleep(300 * Math.pow(3, attempt), signal);
          } catch {
            // 백오프 대기 중의 중단은 예외로 흘리지 않고 중단 상태로 보고한다
            summary.aborted = true;
            return summary;
          }
        }
      }
    }

    summary.done = i + 1;

    if (rows) {
      const { unique, ids, duplicates } = dropBoundaryDuplicates(rows, prevIds);
      prevIds = ids;
      summary.duplicates += duplicates;
      rows = unique;
      summary.total += rows.length;
      onChunk?.(rows, { index: i, start, end, ...summary });
    } else {
      prevIds = new Set(); // 失敗したチャンクとは境界を共有する比較ができない
    }

    report();

    if (summary.total >= maxPoints) {
      summary.limitReached = true;
      break;
    }

    if (waitMs > 0 && i < chunks.length - 1) {
      try {
        await sleep(waitMs, signal);
      } catch {
        summary.aborted = true;
        break;
      }
    }
  }

  return summary;
}

/* ------------------------------------------------------------------ */
/* モックデータ (API 到達不能時のフォールバック)                        */
/* ------------------------------------------------------------------ */

/**
 * 実サーバに到達できない場合に、参照画像に近い形状 (対数正規 + ロングテール) の
 * ダミートランザクションを生成する。必ず「モック表示中」の警告と併せて使うこと。
 */
export function generateMockTransactions(startDate, endDate, count = 10000) {
  const apps = ['/api/order', '/api/user/profile', '/api/search', '/checkout.jsp', '/api/inventory', '/login'];
  const instances = ['WAS-01', 'WAS-02', 'WAS-03'];
  const spanMs = Math.max(endDate.getTime() - startDate.getTime(), 1);

  // 決定的な擬似乱数 (mulberry32) — 再現性のため
  let seed = 0x9e3779b9;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = () => {
    const u = Math.max(rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };

  const rows = [];
  for (let i = 0; i < count; i++) {
    // 対数正規分布 (中央値 ≒ 120ms)
    let rt = Math.exp(Math.log(120) + gaussian() * 0.55);
    // 1% を極端に遅いテールにする
    if (rand() < 0.01) rt *= 3 + rand() * 6;

    const at = startDate.getTime() + rand() * spanMs;
    const isError = rand() < 0.008;

    rows.push({
      instanceName: instances[Math.floor(rand() * instances.length)],
      applicationName: apps[Math.floor(rand() * apps.length)],
      businessId: [1 + Math.floor(rand() * 3)],
      txid: `mock-${i}`,
      startTime: formatApiTime(new Date(at)),
      endTime: formatApiTime(new Date(at + rt)),
      responseTime: Math.round(rt),
      cpuTime: Math.round(rt * (0.2 + rand() * 0.3)),
      sqlTime: Math.round(rt * (0.1 + rand() * 0.5)),
      fetchTime: Math.round(rt * 0.05),
      externalcallTime: 0,
      errorType: isError ? 'ServiceException' : ''
    });
  }
  return rows;
}
