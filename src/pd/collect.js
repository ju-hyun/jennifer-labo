/**
 * X-View トランザクションの収集 (照会ボタン) と、失敗時の扱い
 */
import { collectTransactions, buildChunks, ApiError, generateMockTransactions } from './api.js';
import { TxStore } from './stats.js';
import { fmtInt } from './chart.js';
import { CONFIRM_CHUNKS, MOCK_ALLOWED } from './config.js';
import { state } from './state.js';
import { el } from './dom.js';
import { showNotice } from './notice.js';
import { rangeLabel, readRange, setPreset } from './range.js';
import { getDomainId } from './targets.js';
import { recompute } from './view.js';

export async function runCollection() {
  if (state.collecting) return;

  const domainId = getDomainId();
  if (!domainId) {
    showNotice('ドメインを選択してください。', 'warn');
    return;
  }

  // 「直近N分」はボタンを押した時刻で固定されるため、画面を開いたままだと古い区間を照会してしまう。
  // プリセット選択中は、照会ボタンを押した時点の現在時刻で区間を取り直す。
  if (state.activePreset) setPreset(state.activePreset);

  const range = readRange();
  if (!range) {
    showNotice('開始時刻と終了時刻を正しく指定してください (終了 > 開始)。', 'warn');
    return;
  }

  const plannedChunks = buildChunks(range.start, range.end).length;
  if (plannedChunks > CONFIRM_CHUNKS) {
    const ok = window.confirm(
      `${plannedChunks} 回の逐次照会になります。JENNIFER データサーバへの負荷が大きく、完了まで時間がかかる可能性があります。\n続行しますか？`
    );
    if (!ok) return;
  }

  // 直前の照会結果を比較用スナップショットとして退避する (設計書 §6-4)
  if (state.summary?.count > 0 && state.lastRange) {
    state.snapshot = {
      sorted: state.sorted,
      summary: state.summary,
      label: rangeLabel(state.lastRange)
    };
    el.compareToggle.disabled = false;
  }

  state.collecting = true;
  state.abortController = new AbortController();
  state.store = new TxStore();
  state.drilldownApp = null;
  state.lastRange = range;

  el.fetchBtn.disabled = true;
  el.abortBtn.classList.remove('hidden');
  el.progressCard.classList.remove('hidden');
  el.progressBar.style.width = '0%';
  showNotice('');

  // インスタンス選択時のみ API 側で絞り込む。ビジネスは API に該当パラメータが無いため
  // 収集後にクライアント側でフィルタする (設計書 §3.5 / 制約 C3)。
  const instanceIds =
    state.targetType === 'instance' && state.instanceId ? [state.instanceId] : [];

  const totalChunks = buildChunks(range.start, range.end).length;
  let lastPaint = 0;

  const updateProgress = (info) => {
    const pct = totalChunks ? (info.done / totalChunks) * 100 : 0;
    el.progressBar.style.width = `${pct.toFixed(1)}%`;
    el.progressText.textContent =
      `データロード中... (${info.done}/${totalChunks} チャンク · ${fmtInt(info.total)} 件)`;
  };

  try {
    const result = await collectTransactions({
      domainId,
      instanceIds,
      startDate: range.start,
      endDate: range.end,
      signal: state.abortController.signal,
      onChunk: (rows) => {
        state.store.push(rows);
        // 1秒ごとに中間描画して進行を可視化する
        const now = performance.now();
        if (now - lastPaint > 1000) {
          lastPaint = now;
          recompute({ quiet: true });
        }
      },
      onProgress: updateProgress
    });

    // 全チャンクが失敗した = サーバに到達できていない。
    if (result.chunks > 0 && result.failed === result.chunks) {
      if (MOCK_ALLOWED) {
        state.store.push(generateMockTransactions(range.start, range.end));
        showNotice(
          'JENNIFERサーバに接続できませんでした。以下はモックデータによる表示です。実データではありません。',
          'error'
        );
      } else {
        showNotice(
          'JENNIFERサーバに接続できませんでした。ネットワークとAPIプロキシの設定をご確認ください。',
          'error'
        );
      }
      return;
    }

    const messages = [];
    if (result.aborted) messages.push('収集を中断しました。');
    if (result.limitReached) messages.push('標本上限に到達したため収集を打ち切りました。期間を狭めてください。');
    if (result.failed > 0) messages.push(`${result.failed}/${result.chunks} チャンクの取得に失敗しスキップしました。`);
    if (result.total === 0 && !result.aborted) {
      messages.push('該当期間にトランザクションがありませんでした。');
    }
    showNotice(messages.join(' '), result.failed || result.limitReached ? 'warn' : 'info');
  } catch (err) {
    console.error('Collection failed:', err);
    const reason =
      err instanceof ApiError && err.status === 401
        ? '認証に失敗しました (401)。サーバ側のAPIトークン設定をご確認ください。'
        : `収集中にエラーが発生しました: ${err.message}`;
    if (MOCK_ALLOWED && state.store.length === 0) {
      // 開発時のみ: 画面の挙動を確認できるようモックで描画する
      state.store.push(generateMockTransactions(range.start, range.end));
      showNotice(`${reason} 以下はモックデータによる表示で、実データではありません。`, 'error');
    } else if (state.store.length > 0) {
      // 途中まで収集できた実データは破棄せず、そのまま表示する
      showNotice(`${reason} 取得済みの ${fmtInt(state.store.length)} 件のみを表示しています (不完全なデータです)。`, 'warn');
    } else {
      showNotice(reason, 'error');
    }
  } finally {
    state.collecting = false;
    state.abortController = null;
    el.fetchBtn.disabled = false;
    el.abortBtn.classList.add('hidden');
    el.progressCard.classList.add('hidden');
    recompute();
  }
}

/* ------------------------------------------------------------------ */
/* 再計算・描画                                                        */
/* ------------------------------------------------------------------ */
