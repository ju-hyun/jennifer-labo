/**
 * PTA の実行時設定 (window.PTA_CONFIG) と API のベース URL
 */

// Runtime configuration (pta/config.js에서 window.PTA_CONFIG로 로드)
const PTA_CFG = window.PTA_CONFIG || {};

/**
 * 接続失敗時にダミー(モック)データを表示してよいか。
 * 運用環境で実データと誤認されないよう、開発ビルドか、config.js の ALLOW_MOCK: true の明示指定時のみ許可する。
 */
export const MOCK_ALLOWED = !!(import.meta.env?.DEV || PTA_CFG.ALLOW_MOCK === true);

// Global variables
export const API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/dbmetrics';

export const BUSINESS_METRICS_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/dbmetrics/business';

export const DOMAIN_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/domain';

export const INSTANCE_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/instance';

export const BUSINESS_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/business';
// API 인증 토큰은 클라이언트에 두지 않는다. nginx(운영)/Vite 프록시(로컬)가 요청을
// 업스트림으로 전달할 때 서버 측에서 주입한다.
