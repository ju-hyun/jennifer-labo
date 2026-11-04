// サーバ時間帯 (TIMEZONE) の扱いのテスト
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setTimeZone, getTimeZone, partsOf, wallToDate, addDays, startOfMonth, timeZoneLabel,
  formatYMDH, formatYMD, formatYMDHMS, formatInputValue, parseInputValue
} from '../src/shared/tz.js';

const iso = (d) => d.toISOString();
beforeEach(() => setTimeZone(null));

describe('setTimeZone', () => {
  test('有効な名前は設定され、空はローカル(null)に戻る', () => {
    assert.equal(setTimeZone('Asia/Tokyo'), 'Asia/Tokyo');
    assert.equal(getTimeZone(), 'Asia/Tokyo');
    assert.equal(setTimeZone(''), null);
    assert.equal(setTimeZone(undefined), null);
    assert.equal(getTimeZone(), null);
  });

  test('不正な名前は警告してローカルにフォールバックする', () => {
    const warn = console.warn; let warned = '';
    console.warn = (m) => { warned = m; };
    try {
      assert.equal(setTimeZone('Mars/Olympus'), null);
      assert.match(warned, /不正な時間帯名/);
    } finally { console.warn = warn; }
  });

  test('timeZoneLabel: JST などの短い名前、ローカルなら null', () => {
    assert.equal(timeZoneLabel('Asia/Tokyo'), 'JST');
    assert.equal(timeZoneLabel(null), null);
  });
});

describe('partsOf / wallToDate (固定の期待値)', () => {
  test('UTC 2026-11-04 00:00 は JST で 09:00', () => {
    const p = partsOf(new Date('2026-11-04T00:00:00Z'), 'Asia/Tokyo');
    assert.deepEqual([p.y, p.m, p.d, p.h, p.mi, p.s], [2026, 11, 4, 9, 0, 0]);
    assert.equal(p.dow, 3); // 水曜
  });

  test('同じ瞬間でも時間帯によって日付が変わる (ブラウザが米国・サーバが日本のケース)', () => {
    const t = new Date('2026-12-01T04:00:00Z'); // JST 12/01 13:00、ロサンゼルスは 11/30 20:00
    assert.equal(formatYMD(t, 'Asia/Tokyo'), '20261201');
    assert.equal(formatYMD(t, 'America/Los_Angeles'), '20261130');
  });

  test('JST の壁時計 2026-11-04 09:00 -> UTC 00:00', () => {
    assert.equal(iso(wallToDate({ y: 2026, m: 11, d: 4, h: 9 }, 'Asia/Tokyo')), '2026-11-04T00:00:00.000Z');
  });

  test('0 時ちょうどは hour が 24 ではなく 0 になる', () => {
    assert.equal(partsOf(new Date('2026-11-03T15:00:00Z'), 'Asia/Tokyo').h, 0);
  });

  test('30 分/45 分ずれの時間帯 (インド +5:30、ネパール +5:45)', () => {
    assert.equal(formatYMDHMS(new Date('2026-01-01T00:00:00Z'), 'Asia/Kolkata'), '20260101053000');
    assert.equal(formatYMDHMS(new Date('2026-01-01T00:00:00Z'), 'Asia/Kathmandu'), '20260101054500');
  });

  test('範囲外の月日は繰り上がる (m=13 は翌年 1 月、d=0 は前月末)', () => {
    assert.equal(formatYMD(wallToDate({ y: 2026, m: 13, d: 1 }, 'Asia/Tokyo'), 'Asia/Tokyo'), '20270101');
    assert.equal(formatYMD(wallToDate({ y: 2026, m: 3, d: 0 }, 'Asia/Tokyo'), 'Asia/Tokyo'), '20260228');
  });
});

describe('夏時間', () => {
  const NY = 'America/New_York';

  test('夏時間をまたいで 1 日進めても、壁時計の時刻は変わらない (23 時間後になる)', () => {
    const before = wallToDate({ y: 2026, m: 3, d: 7, h: 12 }, NY); // 3/8 に夏時間開始
    const after = addDays(before, 1, NY);
    const p = partsOf(after, NY);
    assert.deepEqual([p.m, p.d, p.h], [3, 8, 12]);
    assert.equal((after - before) / 3600e3, 23);
  });

  test('夏時間の終了をまたいでも同様 (25 時間後になる)', () => {
    const before = wallToDate({ y: 2026, m: 10, d: 31, h: 12 }, NY);
    const after = addDays(before, 1, NY);
    assert.deepEqual([partsOf(after, NY).m, partsOf(after, NY).d, partsOf(after, NY).h], [11, 1, 12]);
    assert.equal((after - before) / 3600e3, 25);
  });

  test('存在しない時刻 (夏時間開始の 02:30) は直後の存在する時刻になる', () => {
    const p = partsOf(wallToDate({ y: 2026, m: 3, d: 8, h: 2, mi: 30 }, NY), NY);
    assert.deepEqual([p.d, p.h, p.mi], [8, 3, 30]);
  });

  test('2 回ある時刻 (夏時間終了の 01:30) は 1 回目 (夏時間側) になる', () => {
    const t = wallToDate({ y: 2026, m: 11, d: 1, h: 1, mi: 30 }, NY);
    assert.equal(iso(t), '2026-11-01T05:30:00.000Z'); // EDT(UTC-4) の 01:30。EST なら 06:30Z
  });

  test('startOfMonth は夏時間でも月初 0 時になる', () => {
    const p = partsOf(startOfMonth(new Date('2026-03-20T12:00:00Z'), 0, NY), NY);
    assert.deepEqual([p.y, p.m, p.d, p.h, p.mi], [2026, 3, 1, 0, 0]);
  });
});

describe('startOfMonth / addDays', () => {
  test('月オフセットは年をまたぐ (2026-02 の 3 か月前は 2025-11)', () => {
    const p = partsOf(startOfMonth(new Date('2026-02-15T00:00:00Z'), -3, 'Asia/Tokyo'), 'Asia/Tokyo');
    assert.deepEqual([p.y, p.m, p.d, p.h], [2025, 11, 1, 0]);
  });

  test('サーバの月が基準になる: UTC では 11 月でも JST では 12 月', () => {
    // UTC 2026-11-30 20:00 = JST 2026-12-01 05:00
    const t = new Date('2026-11-30T20:00:00Z');
    assert.equal(formatYMDH(startOfMonth(t, 0, 'Asia/Tokyo'), 'Asia/Tokyo'), '2026120100');
    assert.equal(formatYMDH(startOfMonth(t, 1, 'Asia/Tokyo'), 'Asia/Tokyo'), '2027010100');
  });

  test('addDays: 月末をまたぐ', () => {
    const t = wallToDate({ y: 2026, m: 1, d: 31, h: 9 }, 'Asia/Tokyo');
    assert.equal(formatYMDH(addDays(t, 30, 'Asia/Tokyo'), 'Asia/Tokyo'), '2026030209');
  });
});

describe('入力値 (datetime-local)', () => {
  test('formatInputValue / parseInputValue は壁時計で往復する', () => {
    setTimeZone('Asia/Tokyo');
    const d = parseInputValue('2026-11-04T09:30:15');
    assert.equal(iso(d), '2026-11-04T00:30:15.000Z');
    assert.equal(formatInputValue(d), '2026-11-04T09:30:15');
  });

  test('秒なしも受け付け、不正な値は null', () => {
    setTimeZone('Asia/Tokyo');
    assert.equal(iso(parseInputValue('2026-11-04T09:30')), '2026-11-04T00:30:00.000Z');
    assert.equal(parseInputValue(''), null);
    assert.equal(parseInputValue('2026-11-04'), null);
    assert.equal(parseInputValue(null), null);
  });
});

describe('ローカル(未設定)は従来どおりブラウザの時刻', () => {
  test('partsOf / formatYMDH は Date のローカル getter と一致する', () => {
    const d = new Date(2026, 4, 6, 7, 8, 9);
    const p = partsOf(d);
    assert.deepEqual([p.y, p.m, p.d, p.h, p.mi, p.s], [2026, 5, 6, 7, 8, 9]);
    assert.equal(formatYMDH(d), '2026050607');
    assert.equal(formatInputValue(d), '2026-05-06T07:08:09');
  });

  test('wallToDate / addDays / startOfMonth もローカルの Date と一致する', () => {
    assert.equal(wallToDate({ y: 2026, m: 5, d: 6, h: 7 }).getTime(), new Date(2026, 4, 6, 7).getTime());
    assert.equal(startOfMonth(new Date(2026, 4, 20), -1).getTime(), new Date(2026, 3, 1).getTime());
    const base = new Date(2026, 4, 6, 7);
    assert.equal(addDays(base, 30).getTime(), new Date(2026, 5, 5, 7).getTime());
  });
});

describe('無作為な往復変換 (時刻 -> 壁時計 -> 時刻)', () => {
  const zones = ['Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'Pacific/Auckland'];
  test('どの時間帯でも元の時刻に戻る (夏時間の曖昧な 1 時間を除く)', () => {
    let seed = 99; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    let checked = 0;
    for (const tz of zones) {
      for (let i = 0; i < 400; i++) {
        const t = Date.UTC(2024, 0, 1) + Math.floor(rnd() * 3 * 365 * 24 * 3600e3);
        const p = partsOf(t, tz);
        const back = wallToDate(p, tz).getTime();
        // 夏時間終了時の「2 回ある 1 時間」は、どちらの時刻にも戻りうる。壁時計が同じならよしとする
        const q = partsOf(back, tz);
        assert.deepEqual([q.y, q.m, q.d, q.h, q.mi, q.s], [p.y, p.m, p.d, p.h, p.mi, p.s], `${tz} @ ${new Date(t).toISOString()}`);
        if (back !== t) assert.equal(Math.abs(back - t), 3600e3, `${tz}: 往復のずれは夏時間の重複 1 時間のみ`);
        checked++;
      }
    }
    assert.equal(checked, zones.length * 400);
  });
});
