/**
 * ヘルプウィンドウ
 */

let helpWindow = null;

export function openHelp(anchor) {
  const url = `./help.html#${anchor || ''}`;
  if (helpWindow && !helpWindow.closed) {
    helpWindow.location.hash = anchor || '';
    helpWindow.focus();
    return;
  }
  helpWindow = window.open(url, 'pdHelp', 'width=880,height=900,scrollbars=yes');
}

/* ------------------------------------------------------------------ */
/* イベント束ね                                                        */
/* ------------------------------------------------------------------ */
