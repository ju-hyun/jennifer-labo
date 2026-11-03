// 修正後ブラウザをリフレッシュすると変更事項が反映されます。
window.PD_CONFIG = {
  // 1. API Proxy用ベースURL (Proxy設定用)
  BASE_URL: 'https://demo.jennifersoft.co.jp/',

  // 2. APIサーバーのドメインまたはIP (Nginx等でプロキシを使用する場合は空にしておく、直接呼び出す場合はアドレスを入力)
  API_DOMAIN: '',

  // 3. X-Viewトランザクション収集の既定値
  //    - CHUNK_WAIT_MS: 1分チャンク間のウェイト (データサーバ負荷が気になる環境では 100〜500 を推奨)
  //    - MAX_POINTS   : 累積トランザクション件数の安全上限
  CHUNK_WAIT_MS: 0,
  MAX_POINTS: 300000

  // 4. API認証用トークンはこのファイルには置かない。
  //    nginx側の /api/ プロキシ設定でリクエスト転送時にサーバー側から付与する。
};
