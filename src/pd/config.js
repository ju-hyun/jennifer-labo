/**
 * PD の実行時設定 (window.PD_CONFIG) と、そこから導く定数
 */

const PD_CFG = window.PD_CONFIG || {};

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
