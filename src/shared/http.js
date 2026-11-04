/**
 * JENNIFER OpenAPI 呼び出しの共通部分 (PTA / PD で共有)
 *
 * 認証トークンはクライアントに存在しない。/api/ へのリクエストがリバースプロキシ
 * (本番: nginx / ローカル: Vite dev proxy) を通る際にサーバ側で注入される。
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * GET して JSON を返す。401 とそれ以外のエラーは ApiError (status 付き) を投げる。
 * ネットワーク障害は fetch の TypeError、中断は AbortError がそのまま投げられる。
 * @param {string|URL} url
 * @param {{signal?: AbortSignal}} [opts]
 */
export async function getJson(url, { signal } = {}) {
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });
  if (res.status === 401) {
    throw new ApiError('Authentication failed (401)', 401);
  }
  if (!res.ok) {
    throw new ApiError(`HTTP Error: ${res.status}`, res.status);
  }
  return res.json();
}

export const isUnauthorized = (err) => err instanceof ApiError && err.status === 401;
