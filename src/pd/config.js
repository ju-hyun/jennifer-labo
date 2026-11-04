/**
 * PD の実行時設定 (window.PD_CONFIG) と、そこから導く定数
 */

import { setTimeZone, timeZoneLabel } from '../shared/tz.js';

const PD_CFG = window.PD_CONFIG || {};

/**
 * サーバの時間帯 (IANA 名)。指定すると、照会期間の組み立てと表示をその時間帯の壁時計で行う。
 * 未指定/不正ならブラウザのローカル時刻 (従来の動作)。
 */
export const TIMEZONE = setTimeZone(PD_CFG.TIMEZONE);

/** 画面に表示する時間帯の短い名前 (例: 'JST')。ローカル時刻の場合は null */
export const TIMEZONE_LABEL = timeZoneLabel(TIMEZONE);

/**
 * 接続失敗時にダミー(モック)データを表示してよいか。
 * 運用環境で実データと誤認されないよう、開発ビルドか、config.js の ALLOW_MOCK: true の明示指定時のみ許可する。
 */
export const MOCK_ALLOWED = !!(import.meta.env?.DEV || PD_CFG.ALLOW_MOCK === true);

/** この回数を超える逐次照会になる場合は、実行前に確認する (データサーバ負荷・待ち時間のため) */
export const CONFIRM_CHUNKS = PD_CFG.CONFIRM_CHUNKS ?? 120;

/* ------------------------------------------------------------------ */
/* 状態                                                                */
/* ------------------------------------------------------------------ */
