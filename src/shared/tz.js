/**
 * サーバ時間帯 (TIMEZONE) の扱い (PTA / PD 共通)
 *
 * JENNIFER の API は、サーバの時間帯の「壁時計の時刻」(yyyyMMddHH... の文字列) で期間を指定し、
 * 同じ形式で結果を返す。ブラウザのローカル時刻で期間を組み立てると、サーバと異なる時間帯の
 * ブラウザでは意図した区間とずれる (例: 米国のブラウザから JST のサーバを見る)。
 *
 * config.js の TIMEZONE に IANA 名 (例: 'Asia/Tokyo') を指定すると、期間の組み立て・表示を
 * その時間帯の壁時計で行う。未指定なら従来どおりブラウザのローカル時刻を使う。
 * 追加ライブラリは使わず、組み込みの Intl だけで実装している (夏時間のある地域にも対応)。
 */

let activeTz = null;

/**
 * 使用する時間帯を設定する。空なら、または不正な名前なら、ブラウザのローカル時刻にする。
 * @param {string|null|undefined} tz IANA の時間帯名
 * @returns {string|null} 実際に有効になった時間帯 (ローカルなら null)
 */
export function setTimeZone(tz) {
  if (!tz) {
    activeTz = null;
    return null;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    activeTz = tz;
  } catch {
    console.warn(`TIMEZONE '${tz}' は不正な時間帯名です。ブラウザのローカル時刻を使います。`);
    activeTz = null;
  }
  return activeTz;
}

export const getTimeZone = () => activeTz;

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * 時刻を、その時間帯の壁時計の各要素に分解する。
 * @param {Date|number} date
 * @param {string|null} [tz] 省略時は setTimeZone で設定した時間帯 (未設定ならローカル)
 * @returns {{y:number,m:number,d:number,h:number,mi:number,s:number,ms:number,dow:number}} m は 1-12、dow は 0=日曜
 */
export function partsOf(date, tz = activeTz) {
  const t = typeof date === 'number' ? date : date.getTime();
  const dt = new Date(t);
  if (!tz) {
    return {
      y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(),
      h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds(), ms: dt.getMilliseconds(), dow: dt.getDay()
    };
  }
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(dt)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return {
    y: p.year, m: p.month, d: p.day,
    // 一部の実装は 0 時を 24 と返すため、0 に直す
    h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second,
    ms: ((t % 1000) + 1000) % 1000,
    dow: new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
  };
}

/**
 * その時間帯の壁時計の時刻 -> 時刻 (Date)。月・日などが範囲外でも繰り上がる (m=13 は翌年 1 月、d=0 は前月末)。
 * 夏時間で存在しない時刻は直後の時刻に、2 回ある時刻は 1 回目になる (ブラウザの Date と同じ)。
 * @param {{y:number,m:number,d:number,h?:number,mi?:number,s?:number,ms?:number}} wall m は 1-12
 */
export function wallToDate({ y, m, d, h = 0, mi = 0, s = 0, ms = 0 }, tz = activeTz) {
  if (!tz) return new Date(y, m - 1, d, h, mi, s, ms);
  const wall = Date.UTC(y, m - 1, d, h, mi, s, ms);
  // 時間帯の UTC からのずれ = 壁時計を UTC とみなした値 - 実際の時刻
  const offsetAt = (t) => {
    const p = partsOf(t, tz);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, p.ms) - t;
  };
  // ずれは時刻に依存する (夏時間) ため、2 回収束させる
  const t1 = wall - offsetAt(wall);
  const t2 = wall - offsetAt(t1);
  const back = partsOf(t2, tz);
  if (Date.UTC(back.y, back.m - 1, back.d, back.h, back.mi, back.s, back.ms) !== wall) {
    // 夏時間の開始で「存在しない時刻」。2 つの候補を行き来してしまうので、遅い方 (直後の時刻) を採る。
    // ブラウザの new Date(y, m, d, h, mi) と同じ動作。
    return new Date(Math.max(t1, t2));
  }
  // 夏時間の終了で「2 回ある時刻」は、早い方 (1 回目) になる。これもブラウザの Date と同じ。
  return new Date(t2);
}

/** n 日後 (壁時計の日付で数える。夏時間をまたいでも同じ時刻になる) */
export function addDays(date, n, tz = activeTz) {
  const p = partsOf(date, tz);
  return wallToDate({ y: p.y, m: p.m, d: p.d + n, h: p.h, mi: p.mi, s: p.s, ms: p.ms }, tz);
}

/** date を含む月の 1 日 0 時から monthOffset か月ずらした時刻 */
export function startOfMonth(date, monthOffset = 0, tz = activeTz) {
  const p = partsOf(date, tz);
  return wallToDate({ y: p.y, m: p.m + monthOffset, d: 1 }, tz);
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 画面表示用の時間帯の短い名前 (例: 'JST')。ローカルの場合は null */
export function timeZoneLabel(tz = activeTz) {
  if (!tz) return null;
  try {
    const part = new Intl.DateTimeFormat('ja-JP', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    return part ? part.value : tz;
  } catch {
    return tz;
  }
}

/** "yyyyMMddHH" (API の time_pattern) */
export function formatYMDH(date, tz = activeTz) {
  const p = partsOf(date, tz);
  return `${p.y}${pad(p.m)}${pad(p.d)}${pad(p.h)}`;
}

/** "yyyyMMdd" */
export function formatYMD(date, tz = activeTz) {
  const p = partsOf(date, tz);
  return `${p.y}${pad(p.m)}${pad(p.d)}`;
}

/** "yyyyMMddHHmmss" (API の time_pattern) */
export function formatYMDHMS(date, tz = activeTz) {
  const p = partsOf(date, tz);
  return `${p.y}${pad(p.m)}${pad(p.d)}${pad(p.h)}${pad(p.mi)}${pad(p.s)}`;
}

/** <input type="datetime-local" step=1> の値 "yyyy-MM-ddTHH:mm:ss" */
export function formatInputValue(date, tz = activeTz) {
  const p = partsOf(date, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}

/** <input type="datetime-local"> の値 ("yyyy-MM-ddTHH:mm" または ":ss" つき) -> 時刻。不正なら null */
export function parseInputValue(value, tz = activeTz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? ''));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? 0].map(Number);
  return wallToDate({ y, m: mo, d, h, mi, s }, tz);
}
