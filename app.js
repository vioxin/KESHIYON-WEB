import { State, COLS, MAX_ROWS } from './game.js';
import { DEFAULT_PARAMS } from './ai.js';

const API_URL_DEFAULT = 'https://MOUDOKU-keshiyon.hf.space/get_move';
// Google Apps Script Web App URLを設定すると、勝敗が決まった対局だけ共有シートへ記録します。
// 未設定のままなら記録機能は無効です。例: https://script.google.com/macros/s/DEPLOYMENT_ID/exec
const SHEETS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwE2LgHC1IomUW-Pih6M-L4mx56DYPrBIAhiqCR8rTA_gvBzUVEwOLbAf6Flql4qy0Rfg/exec';
// Render WebSocket URLを app.js に埋め込まなくても、画面から設定できます。
const ONLINE_URL_DEFAULT = '';
let state = new State();
let moveCount = 0;
let moveHistory = [];
let searchWorker = null;
let apiController = null;
let apiBusy = false;
let autoMoveTimer = null;
const online = {
  socket: null,
  connected: false,
  roomCode: null,
  seat: null,
  status: 'offline',
  savedPlayerTypes: null,
  lastMoveCount: 0,
  pendingMove: false,
  matchmaking: false,
};

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const logEl = $('game-log');
const p1Select = $('p1-type');
const p2Select = $('p2-type');
const aiButton = $('ai-move');
const newGameButton = $('new-game');
const onlineUrlInput = $('online-url');
const onlineCodeInput = $('online-code');
const sliderMap = [
  ['time-limit', 'time-limit-value', (v) => `${Number(v).toFixed(1)} 秒`],
  ['w-score', 'w-score-value', (v) => String(v)],
  ['w-three', 'w-three-value', (v) => String(v)],
  ['w-two', 'w-two-value', (v) => String(v)],
  ['w-center', 'w-center-value', (v) => String(v)],
  ['w-one', 'w-one-value', (v) => String(v)],
  ['w-expand', 'w-expand-value', (v) => String(v)],
];

function log(message, type = 'system') {
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function getPlayerType(isCircleTurn = state.isCircleTurn) {
  return (isCircleTurn ? p1Select : p2Select).value;
}

function getParams() {
  return {
    timeLimit: Number($('time-limit').value),
    wScore: Number($('w-score').value),
    wThree: Number($('w-three').value),
    wTwo: Number($('w-two').value),
    wOne: Number($('w-one').value),
    wCenter: Number($('w-center').value),
    wExpand: Number($('w-expand').value),
  };
}

function currentPlayerName(isCircleTurn = state.isCircleTurn) {
  return isCircleTurn ? '○' : '×';
}

function cancelPendingAI() {
  if (autoMoveTimer !== null) {
    clearTimeout(autoMoveTimer);
    autoMoveTimer = null;
  }
  if (searchWorker) {
    searchWorker.terminate();
    searchWorker = null;
  }
  if (apiController) {
    apiController.abort();
    apiController = null;
  }
  apiBusy = false;
}

function canCurrentUserMove() {
  if (online.roomCode) {
    if (!online.connected || online.status !== 'playing' || state.gameOver || online.seat === null || online.pendingMove) return false;
    return online.seat === (state.isCircleTurn ? 0 : 1);
  }
  return getPlayerType() === 'human' && !state.gameOver && !searchWorker && !apiBusy;
}

function refresh() {
  $('o-score').textContent = String(state.ptsO);
  $('x-score').textContent = String(state.ptsX);
  $('empty-count').textContent = String(state.empty);
  $('row-count').textContent = `${state.freed} / ${MAX_ROWS}`;
  $('move-count').textContent = String(moveCount);

  const mode = $('mode-state');
  if (state.willDelete) {
    mode.textContent = '▧ 削除モード';
    mode.className = 'mode-delete';
  } else {
    mode.textContent = '🔒 ロック';
    mode.className = 'mode-lock';
  }

  const humanTurn = canCurrentUserMove() && !searchWorker && !apiBusy;
  $('o-turn').textContent = state.isCircleTurn ? '手番中' : '待機';
  $('x-turn').textContent = state.isCircleTurn ? '待機' : '手番中';
  $('o-turn').classList.toggle('active', state.isCircleTurn && !state.gameOver);
  $('x-turn').classList.toggle('active', !state.isCircleTurn && !state.gameOver);

  const playerLabel = currentPlayerName();
  const indicator = $('turn-indicator');
  if (state.gameOver) {
    indicator.innerHTML = '<span class="indicator-dot"></span> 対局終了';
  } else {
    const colorClass = state.isCircleTurn ? 'orange-dot' : 'blue-dot';
    indicator.innerHTML = `<span class="indicator-dot ${colorClass}"></span> ${playerLabel} の番`;
  }

  renderBoard(humanTurn);
  aiButton.disabled = !!online.roomCode || state.gameOver || !!searchWorker || apiBusy || getPlayerType() !== 'human';
  newGameButton.disabled = false;
  updateOnlineUI();

  const resultPanel = $('result-panel');
  resultPanel.hidden = !state.gameOver;
  if (state.gameOver) {
    const diff = state.ptsO - state.ptsX;
    const result = diff > 0 ? '○ の勝利！' : diff < 0 ? '× の勝利！' : '引き分け！';
    resultPanel.textContent = `${result}　○ ${state.ptsO} 点 vs × ${state.ptsX} 点　／　手数 ${moveCount}`;
  }
}

function renderBoard(humanTurn) {
  boardEl.replaceChildren();
  const playable = new Set(state.gameOver ? [] : state.moves().map(([c, r]) => `${c},${r}`));
  for (let row = MAX_ROWS - 1; row >= 0; row--) {
    for (let col = 0; col < COLS; col++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.setAttribute('role', 'gridcell');
      cell.dataset.col = String(col);
      cell.dataset.row = String(row);
      const key = `${col},${row}`;
      const hidden = row >= state.freed;
      if (hidden) {
        cell.classList.add('hidden-cell');
        cell.disabled = true;
        cell.setAttribute('aria-label', `列${col}、未開放の行`);
      } else {
        const piece = state.board[col][row];
        if (piece === 'o') {
          cell.textContent = '○';
          cell.classList.add('piece-o');
          cell.setAttribute('aria-label', `列${col} 行${row}、まる`);
        } else if (piece === 'x') {
          cell.textContent = '×';
          cell.classList.add('piece-x');
          cell.setAttribute('aria-label', `列${col} 行${row}、ばつ`);
        } else if (piece === '^') {
          cell.textContent = '▲';
          cell.classList.add('piece-hat');
          cell.setAttribute('aria-label', `列${col} 行${row}、ロックされた石`);
        } else {
          cell.textContent = '';
          cell.setAttribute('aria-label', `列${col} 行${row}、空き`);
        }
        if (playable.has(key)) {
          cell.classList.add('playable');
          cell.disabled = !humanTurn;
          cell.title = `列 ${col}・行 ${row} に置く`;
          cell.addEventListener('click', () => online.roomCode ? sendOnlineMove(col, row) : playMove(col, row, 'human'));
        } else {
          cell.disabled = true;
        }
      }
      boardEl.appendChild(cell);
    }
  }
}

function playMove(col, row, source) {
  if (state.gameOver || !state.moves().some(([c, r]) => c === col && r === row)) return false;
  const moverIsCircle = state.isCircleTurn;
  const previousO = state.ptsO;
  const previousX = state.ptsX;
  const previousRows = state.freed;
  try {
    state = state.apply(col, row);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error), 'error');
    return false;
  }
  moveCount++;
  moveHistory.push([col, row]);
  const side = moverIsCircle ? '○' : '×';
  if (source === 'ai') log(`AI(${side}) → 列=${col} 行=${row}`, 'ai');
  else log(`${side} が列=${col} 行=${row} に配置`, moverIsCircle ? 'o' : 'x');
  if (state.ptsO !== previousO) log(`○ が四目！ +${state.ptsO - previousO}点（合計 ${state.ptsO}）`, 'o');
  if (state.ptsX !== previousX) log(`× が四目！ +${state.ptsX - previousX}点（合計 ${state.ptsX}）`, 'x');
  if (state.freed > previousRows) log(`盤面が ${state.freed} 行に拡張されました。`, 'system');
  refresh();

  if (state.gameOver) {
    const diff = state.ptsO - state.ptsX;
    log(diff > 0 ? `ゲーム終了：○ の勝利！（${state.ptsO} - ${state.ptsX}）` : diff < 0 ? `ゲーム終了：× の勝利！（${state.ptsO} - ${state.ptsX}）` : `ゲーム終了：引き分け（${state.ptsO} - ${state.ptsX}）`, 'system');
    setStatus('対局終了', '結果が確定しました。新しいゲームで再戦できます。', 'DONE');
    if (!online.roomCode) void recordCompletedMatch();
  } else {
    scheduleNextMove();
  }
  return true;
}

function setStatus(title, message, pill = 'READY') {
  $('ai-status-title').textContent = title;
  $('ai-status').textContent = message;
  $('status-pill').textContent = pill;
}

function scheduleNextMove() {
  if (online.roomCode || state.gameOver || searchWorker || apiBusy) return;
  if (autoMoveTimer !== null) {
    clearTimeout(autoMoveTimer);
    autoMoveTimer = null;
  }
  const kind = getPlayerType();
  if (kind === 'human') {
    setStatus('あなたの番です', `${currentPlayerName()} の置けるマスをタップしてください。`, 'YOUR TURN');
    refresh();
    return;
  }
  const turn = currentPlayerName();
  setStatus(`${turn} のAIを準備中`, kind === 'api' ? '外部APIに指し手を問い合わせます。' : 'ブラウザ内のローカルAIが指し手を計算します。', 'THINKING');
  refresh();
  autoMoveTimer = setTimeout(() => {
    autoMoveTimer = null;
    requestAIMove(false);
  }, 300);
}

function requestAIMove(forceLocal) {
  if (state.gameOver || searchWorker || apiBusy) return;
  if (autoMoveTimer !== null) {
    clearTimeout(autoMoveTimer);
    autoMoveTimer = null;
  }
  const kind = forceLocal ? 'local' : getPlayerType();
  if (!forceLocal && kind === 'human') return;
  if (kind === 'api') {
    requestExternalMove();
    return;
  }
  const turn = currentPlayerName();
  setStatus(`${turn} のローカルAIが思考中`, '反復深化とαβ枝刈りで指し手を検索しています。', 'THINKING');
  log(`${turn} がローカルAIで思考開始`, 'ai');
  refresh();
  const worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
  searchWorker = worker;
  worker.onmessage = (event) => {
    if (searchWorker !== worker) return;
    const data = event.data;
    if (data.type === 'progress') {
      const p = data.progress;
      $('ai-status-title').textContent = `${turn} のAIが思考中 · 深さ ${p.depth}`;
      $('ai-status').textContent = `候補手 (${p.move[0]}, ${p.move[1]}) ／ 評価 ${Number(p.value).toFixed(0)} ／ ノード ${p.nodes.toLocaleString()} ／ ${p.elapsed.toFixed(2)} 秒`;
      $('status-pill').textContent = 'SEARCHING';
    } else if (data.type === 'done') {
      worker.terminate();
      searchWorker = null;
      const result = data.result;
      if (result.move) {
        setStatus(`${turn} のAIが選択しました`, `列 ${result.move[0]}・行 ${result.move[1]} ／ ${result.elapsed.toFixed(2)} 秒`, 'MOVE');
        if (!playMove(result.move[0], result.move[1], 'ai')) {
          log('AIが返した手を適用できませんでした。', 'error');
          refresh();
        }
      } else {
        log('AIに合法手がありません。', 'error');
        setStatus('AIの手がありません', '新しいゲームを開始してください。', 'ERROR');
        refresh();
      }
    } else if (data.type === 'error') {
      worker.terminate();
      searchWorker = null;
      log(`ローカルAIエラー: ${data.message}`, 'error');
      setStatus('AIエラー', data.message, 'ERROR');
      refresh();
    }
  };
  worker.onerror = (event) => {
    if (searchWorker !== worker) return;
    worker.terminate();
    searchWorker = null;
    log(`AIワーカーのエラー: ${event.message || '詳細不明'}`, 'error');
    setStatus('AIエラー', 'ブラウザの開発者コンソールも確認してください。', 'ERROR');
    refresh();
  };
  worker.postMessage({ state: state.toJSON(), params: getParams() });
}

async function requestExternalMove() {
  const endpoint = $('api-url').value.trim() || API_URL_DEFAULT;
  const turn = currentPlayerName();
  const payload = {
    board: Array.from({ length: COLS }, (_, col) => Array.from({ length: MAX_ROWS }, (_, row) => {
      const piece = state.board[col][row];
      return piece === 'o' ? 1 : piece === 'x' ? -1 : piece === '^' ? 2 : 0;
    })),
    current_player: state.isCircleTurn ? 1 : -1,
    freed: state.freed,
    will_be_deleted: state.willDelete,
    points_p1: state.ptsO,
    points_p2: state.ptsX,
  };
  apiBusy = true;
  apiController = new AbortController();
  setStatus(`${turn} の外部APIに接続中`, endpoint, 'API');
  log(`${turn} が外部APIに指し手を要求`, 'ai');
  refresh();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: apiController.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json();
    const col = Number(data.best_col);
    const row = Number(data.best_row);
    const legal = state.moves().some(([c, r]) => c === col && r === row);
    if (!Number.isInteger(col) || !Number.isInteger(row) || !legal) {
      throw new Error(`APIが合法でない手を返しました: (${data.best_col}, ${data.best_row})`);
    }
    const probs = Array.isArray(data.probabilities) ? data.probabilities : [];
    const action = col * MAX_ROWS + row;
    const probability = action < probs.length ? Number(probs[action]) : NaN;
    if (Number.isFinite(probability)) log(`外部API応答: (${col}, ${row}) 確率 ${(probability * 100).toFixed(1)}%`, 'ai');
    else log(`外部API応答: (${col}, ${row})`, 'ai');
    apiBusy = false;
    apiController = null;
    setStatus(`${turn} の外部APIが選択しました`, `列 ${col}・行 ${row}`, 'MOVE');
    playMove(col, row, 'ai');
  } catch (error) {
    if (error?.name === 'AbortError') return;
    apiBusy = false;
    apiController = null;
    const detail = error instanceof Error ? error.message : String(error);
    log(`外部APIエラー: ${detail}`, 'error');
    log('CORS制限・APIの停止・通信設定を確認してください。', 'error');
    setStatus('外部APIに接続できません', 'ブラウザから直接通信できるAPIが必要です。必要なら「AIに手を選ばせる」でローカルAIを使えます。', 'API ERROR');
    refresh();
  }
}

function setRecordStatus(message, kind = 'info') {
  const element = $('record-status');
  if (!element) return;
  element.textContent = message;
  element.className = `record-status record-${kind}`;
}

function isSheetsEndpointConfigured() {
  return typeof SHEETS_ENDPOINT === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(SHEETS_ENDPOINT);
}

async function recordCompletedMatch() {
  const diff = state.ptsO - state.ptsX;
  // This shared dataset intentionally contains wins/losses only: draws and unfinished games are excluded.
  if (diff === 0) {
    setRecordStatus('引き分けのため保存対象外', 'muted');
    log('引き分けのため、共有対戦記録には保存しません。', 'system');
    return;
  }
  if (!isSheetsEndpointConfigured()) {
    setRecordStatus('未設定：Apps Script URLが必要', 'muted');
    log('勝敗は確定しましたが、Google Sheets連携URLが未設定のため共有記録は保存されません。', 'system');
    return;
  }

  const matchId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `keshiyon_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
  const payload = {
    version: 1,
    matchId,
    moves: moveHistory.map(([col, row]) => [col, row]),
    moveCount,
    ptsO: state.ptsO,
    ptsX: state.ptsX,
    p1Type: p1Select.value,
    p2Type: p2Select.value,
  };
  setRecordStatus('共有シートへ送信中…', 'pending');
  try {
    // Apps Script ContentService has limited CORS control; text/plain + no-cors avoids a preflight.
    // Opaque responses cannot confirm whether the spreadsheet write succeeded.
    await fetch(SHEETS_ENDPOINT, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    setRecordStatus('送信要求済み（保存結果は確認不可）', 'pending');
    log('勝敗が確定した対局の記録送信要求を出しました。ブラウザの仕様上、シートへの保存完了は直接確認できません。', 'system');
  } catch (error) {
    setRecordStatus('送信エラー：通信を確認してください', 'error');
    log(`対戦記録の送信に失敗しました: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function startNewGame() {
  cancelPendingAI();
  state = new State();
  moveCount = 0;
  moveHistory = [];
  logEl.replaceChildren();
  log('新しいゲームを開始しました。', 'system');
  setStatus('対局準備完了', '置けるマスをタップして対局を始めてください。', 'READY');
  refresh();
  scheduleNextMove();
}

p1Select.addEventListener('change', () => {
  if (online.roomCode) return;
  if (autoMoveTimer !== null) { clearTimeout(autoMoveTimer); autoMoveTimer = null; }
  refresh();
  scheduleNextMove();
});
p2Select.addEventListener('change', () => {
  if (online.roomCode) return;
  if (autoMoveTimer !== null) { clearTimeout(autoMoveTimer); autoMoveTimer = null; }
  refresh();
  scheduleNextMove();
});
aiButton.addEventListener('click', () => requestAIMove(true));
newGameButton.addEventListener('click', handleNewGameClick);
$('clear-log').addEventListener('click', () => logEl.replaceChildren());
$('reset-params').addEventListener('click', () => {
  $('time-limit').value = String(DEFAULT_PARAMS.timeLimit);
  $('w-score').value = String(DEFAULT_PARAMS.wScore);
  $('w-three').value = String(DEFAULT_PARAMS.wThree);
  $('w-two').value = String(DEFAULT_PARAMS.wTwo);
  $('w-center').value = String(DEFAULT_PARAMS.wCenter);
  $('w-one').value = String(DEFAULT_PARAMS.wOne);
  $('w-expand').value = String(DEFAULT_PARAMS.wExpand);
  for (const [inputId, outputId, format] of sliderMap) $(outputId).textContent = format($(inputId).value);
});
for (const [inputId, outputId, format] of sliderMap) {
  $(inputId).addEventListener('input', (event) => {
    $(outputId).textContent = format(event.target.value);
  });
}

if (isSheetsEndpointConfigured()) setRecordStatus('Google Sheets連携：設定済み', 'ready');
else setRecordStatus('未設定：勝敗記録はまだ共有されません', 'muted');
log('KESHIYON ブラウザ版を起動しました。', 'system');
log('盤面をタップするか、対戦設定でローカルAIを選んでください。', 'system');
refresh();

// ---------------------------------------------------------------------------
// Online multiplayer (Render WebSocket server). The server is authoritative:
// clients only submit moves and render the verified server state.
// ---------------------------------------------------------------------------
function onlineStatus(message, kind = 'info') {
  const el = $('online-status');
  if (!el) return;
  el.textContent = message;
  el.className = `online-status online-${kind}`;
}

function buildWebSocketUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) throw new Error('RenderサーバーURLを入力してください。');
  const url = new URL(raw);
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)) throw new Error('URLは https:// または wss:// で指定してください。');
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function updateOnlineUI() {
  if (!$('online-connect')) return;
  const inRoom = Boolean(online.roomCode);
  const connected = online.connected && online.socket && online.socket.readyState === WebSocket.OPEN;
  $('online-connect').disabled = connected;
  $('online-connect').textContent = connected ? '接続済み' : 'サーバーに接続';
  onlineUrlInput.disabled = connected;
  $('online-create').disabled = !connected || inRoom;
  $('online-match').disabled = !connected || inRoom;
  $('online-join').disabled = !connected || inRoom;
  onlineCodeInput.disabled = !connected || inRoom;
  $('online-leave').disabled = !connected || (!inRoom && !online.matchmaking);
  $('online-leave').textContent = online.matchmaking ? 'マッチングをキャンセル' : 'オンラインから退出';
  $('room-code-display').hidden = !inRoom || !online.roomCode;
  $('room-code-display').textContent = inRoom ? `ROOM CODE  ${online.roomCode}` : '';
  p1Select.disabled = inRoom;
  p2Select.disabled = inRoom;
  newGameButton.textContent = inRoom
    ? (state.gameOver && online.status === 'finished' ? '↻ 再戦を申し込む' : '退出して新規ゲーム')
    : '↻ 新しいゲーム';
}

function sendOnlineMessage(payload) {
  if (!online.socket || online.socket.readyState !== WebSocket.OPEN) {
    onlineStatus('サーバーに接続されていません。まず接続してください。', 'error');
    return false;
  }
  online.socket.send(JSON.stringify(payload));
  return true;
}

function connectOnline() {
  if (online.socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(online.socket.readyState)) return;
  let wsUrl;
  try {
    wsUrl = buildWebSocketUrl(onlineUrlInput.value || ONLINE_URL_DEFAULT);
  } catch (error) {
    onlineStatus(error.message || String(error), 'error');
    return;
  }
  try { localStorage.setItem('keshiyon-online-url', onlineUrlInput.value.trim()); } catch {}
  onlineStatus('Renderサーバーに接続中… 起動直後は1分ほどかかる場合があります。', 'pending');
  const socket = new WebSocket(wsUrl);
  online.socket = socket;
  socket.addEventListener('open', () => {
    if (online.socket !== socket) return;
    online.connected = true;
    onlineStatus('サーバーに接続しました。部屋を作るか、オンラインマッチを開始してください。', 'ready');
    updateOnlineUI();
  });
  socket.addEventListener('message', (event) => {
    if (online.socket !== socket) return;
    let data;
    try { data = JSON.parse(event.data); }
    catch { onlineStatus('サーバーから不明な形式の応答が届きました。', 'error'); return; }
    handleOnlineMessage(data);
  });
  socket.addEventListener('error', () => {
    if (online.socket === socket) onlineStatus('接続エラー。Render URL、デプロイ状態、起動中かどうかを確認してください。', 'error');
  });
  socket.addEventListener('close', () => {
    if (online.socket !== socket) return;
    online.socket = null;
    online.connected = false;
    if (online.roomCode) deactivateOnlineRoom(false);
    online.roomCode = null;
    online.seat = null;
    online.status = 'offline';
    onlineStatus('サーバーとの接続が切れました。必要なら再接続してください。', 'error');
    updateOnlineUI();
    refresh();
  });
  updateOnlineUI();
}

function activateOnlineRoom(roomCode, seat, status) {
  if (!online.roomCode) {
    cancelPendingAI();
    state = new State();
    moveHistory = [];
    moveCount = 0;
    online.pendingMove = false;
  }
  if (!online.roomCode && online.savedPlayerTypes === null) {
    online.savedPlayerTypes = [p1Select.value, p2Select.value];
  }
  online.matchmaking = false;
  online.roomCode = roomCode;
  online.seat = Number(seat);
  online.status = status;
  p1Select.value = 'human';
  p2Select.value = 'human';
  p1Select.disabled = true;
  p2Select.disabled = true;
  updateOnlineUI();
}

function deactivateOnlineRoom(resetBoard = true) {
  online.roomCode = null;
  online.seat = null;
  online.status = 'offline';
  online.lastMoveCount = 0;
  online.pendingMove = false;
  online.matchmaking = false;
  if (online.savedPlayerTypes) {
    p1Select.value = online.savedPlayerTypes[0];
    p2Select.value = online.savedPlayerTypes[1];
    online.savedPlayerTypes = null;
  }
  cancelPendingAI();
  if (resetBoard) {
    state = new State();
    moveCount = 0;
    moveHistory = [];
    logEl.replaceChildren();
    refresh();
    scheduleNextMove();
  } else {
    refresh();
  }
  updateOnlineUI();
}

function handleOnlineMessage(data) {
  switch (data.type) {
    case 'connected':
      online.connected = true;
      onlineStatus('サーバーに接続しました。', 'ready');
      updateOnlineUI();
      break;
    case 'room_created':
      activateOnlineRoom(data.roomCode, data.seat, 'waiting');
      state = new State(data.state);
      moveHistory = Array.isArray(data.moves) ? data.moves : [];
      moveCount = moveHistory.length;
      online.lastMoveCount = moveCount;
      log(`ルーム ${data.roomCode} を作成しました。相手の参加を待っています。`, 'system');
      onlineStatus(`ルーム ${data.roomCode} を作成しました。コードを友達に共有してください。`, 'ready');
      setStatus('対戦相手を待っています', `ルームコード：${data.roomCode}`, 'WAITING');
      refresh();
      break;
    case 'room_joined':
    case 'match_found':
      activateOnlineRoom(data.roomCode, data.seat, 'playing');
      if (data.state) state = new State(data.state);
      moveHistory = Array.isArray(data.moves) ? data.moves : [];
      moveCount = moveHistory.length;
      online.lastMoveCount = moveCount;
      if (data.type === 'match_found') log(`オンラインマッチ成立：ルーム ${data.roomCode}`, 'system');
      else log(`ルーム ${data.roomCode} に参加しました。`, 'system');
      onlineStatus(`対戦中：あなたは ${online.seat === 0 ? '○（先手）' : '×（後手）'} です。`, 'ready');
      setStatus('オンライン対戦開始', online.seat === 0 ? 'あなたは○（先手）です。' : 'あなたは×（後手）です。', 'ONLINE');
      refresh();
      break;
    case 'room_update': {
      const isNewRoom = online.roomCode !== data.roomCode;
      if (isNewRoom && Number.isInteger(data.seat)) activateOnlineRoom(data.roomCode, data.seat, data.status || 'playing');
      const before = state;
      const oldLength = moveHistory.length;
      const wasOver = state.gameOver;
      if (data.state) state = new State(data.state);
      moveHistory = Array.isArray(data.moves) ? data.moves : [];
      moveCount = moveHistory.length;
      online.status = data.status || (state.gameOver ? 'finished' : 'playing');
      online.pendingMove = false;
      if (data.rematch) {
        log('両者が再戦を希望したため、新しい対局を開始しました。', 'system');
        setStatus('再戦開始', online.seat === 0 ? 'あなたは○（先手）です。' : 'あなたは×（後手）です。', 'ONLINE');
      } else if (data.lastMove && moveCount > oldLength) {
        const [col, row] = data.lastMove.move;
        const side = data.lastMove.seat === 0 ? '○' : '×';
        log(`${side} が列=${col} 行=${row} に配置`, data.lastMove.seat === 0 ? 'o' : 'x');
        if (state.ptsO !== before.ptsO) log(`○ が四目！ +${state.ptsO - before.ptsO}点（合計 ${state.ptsO}）`, 'o');
        if (state.ptsX !== before.ptsX) log(`× が四目！ +${state.ptsX - before.ptsX}点（合計 ${state.ptsX}）`, 'x');
        if (state.freed > before.freed) log(`盤面が ${state.freed} 行に拡張されました。`, 'system');
      }
      online.lastMoveCount = moveCount;
      refresh();
      if (state.gameOver && !wasOver) {
        const diff = state.ptsO - state.ptsX;
        const result = diff > 0 ? '○ の勝利' : diff < 0 ? '× の勝利' : '引き分け';
        log(`ゲーム終了：${result}（${state.ptsO} - ${state.ptsX}）`, 'system');
        setStatus('オンライン対局終了', `${result}。${diff === 0 ? '引き分けは記録されません。' : '勝敗確定対局をスプレッドシートへ記録します。'}`, 'DONE');
        onlineStatus(diff === 0 ? '引き分け：集計対象外です。' : '勝敗確定。共有記録の保存結果を待っています…', diff === 0 ? 'info' : 'pending');
      } else if (!state.gameOver && online.status === 'playing') {
        setStatus(online.seat === (state.isCircleTurn ? 0 : 1) ? 'あなたの番です' : '相手の番です', online.seat === (state.isCircleTurn ? 0 : 1) ? '盤面の置けるマスをタップしてください。' : '相手の着手を待っています。', 'ONLINE');
      }
      updateOnlineUI();
      break;
    }
    case 'matchmaking_wait':
      online.matchmaking = true;
      updateOnlineUI();
      onlineStatus('オンラインマッチ待機中… 相手が見つかると自動で対局が始まります。', 'pending');
      setStatus('対戦相手を検索中', 'この画面を開いたままお待ちください。', 'MATCHING');
      break;
    case 'matchmaking_cancelled':
      online.matchmaking = false;
      onlineStatus('オンラインマッチの待機をキャンセルしました。', 'info');
      updateOnlineUI();
      break;
    case 'rematch_wait':
      onlineStatus('再戦リクエストを送信しました。相手の返答を待っています。', 'pending');
      setStatus('再戦待機中', '相手も「再戦を申し込む」を押すと開始します。', 'WAITING');
      break;
    case 'record_status':
      if (data.status === 'saved') {
        setRecordStatus('オンライン対局：スプレッドシート保存済み', 'ready');
        onlineStatus('勝敗確定対局を共有スプレッドシートに保存しました。', 'ready');
        log('オンライン対局をGoogleスプレッドシートに保存しました。', 'system');
      } else if (data.status === 'draw') {
        onlineStatus('引き分けのため記録対象外です。', 'info');
      } else {
        onlineStatus(`対局は終了しましたが、記録保存を確認できません：${data.message || 'URL設定を確認してください。'}`, 'error');
        log(`オンライン対局の保存状況：${data.message || data.status}`, 'error');
      }
      break;
    case 'opponent_left':
      log('相手が切断または退出しました。オンラインルームは終了しました。', 'error');
      onlineStatus('相手が退出しました。新しい部屋を作成できます。', 'error');
      deactivateOnlineRoom(true);
      break;
    case 'room_left':
      onlineStatus('ルームから退出しました。', 'info');
      deactivateOnlineRoom(true);
      break;
    case 'room_expired':
      onlineStatus('待機ルームの有効期限が切れました。もう一度作成してください。', 'error');
      deactivateOnlineRoom(true);
      break;
    case 'room_error':
      online.pendingMove = false;
      refresh();
      onlineStatus(data.message || 'オンライン対戦エラー', 'error');
      log(data.message || 'オンライン対戦エラー', 'error');
      break;
    case 'pong':
      break;
    default:
      console.debug('Unknown online message', data);
  }
}

function sendOnlineMove(col, row) {
  if (!online.roomCode || online.status !== 'playing') return;
  const expectedSeat = state.isCircleTurn ? 0 : 1;
  if (online.seat !== expectedSeat) {
    onlineStatus('相手の番です。着手を待ってください。', 'info');
    return;
  }
  if (sendOnlineMessage({ type: 'move', col, row })) {
    online.pendingMove = true;
    refresh();
  }
}

function createOnlineRoom() {
  if (!sendOnlineMessage({ type: 'create_room' })) return;
  onlineStatus('ルームを作成しています…', 'pending');
}

function joinOnlineRoom() {
  const code = onlineCodeInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) {
    onlineStatus('6文字のルームコードを入力してください。', 'error');
    return;
  }
  if (sendOnlineMessage({ type: 'join_room', roomCode: code })) onlineStatus(`ルーム ${code} に参加中…`, 'pending');
}

function startOnlineMatchmaking() {
  if (sendOnlineMessage({ type: 'quick_match' })) onlineStatus('マッチングを開始しました。', 'pending');
}

function leaveOnlineRoom() {
  if (online.roomCode) sendOnlineMessage({ type: 'leave_room' });
  else if (online.matchmaking) sendOnlineMessage({ type: 'cancel_matchmaking' });
}

function handleNewGameClick() {
  if (!online.roomCode) {
    startNewGame();
    return;
  }
  if (state.gameOver && online.status === 'finished') {
    sendOnlineMessage({ type: 'rematch_request' });
    onlineStatus('再戦を申し込みました。', 'pending');
    return;
  }
  if (window.confirm('オンラインルームから退出して新しいローカル対局を始めますか？相手の対局も終了します。')) {
    sendOnlineMessage({ type: 'leave_room' });
  }
}

$('online-connect').addEventListener('click', connectOnline);
$('online-create').addEventListener('click', createOnlineRoom);
$('online-join').addEventListener('click', joinOnlineRoom);
$('online-match').addEventListener('click', startOnlineMatchmaking);
$('online-leave').addEventListener('click', leaveOnlineRoom);
onlineCodeInput.addEventListener('input', () => {
  const start = onlineCodeInput.selectionStart;
  onlineCodeInput.value = onlineCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  try { onlineCodeInput.setSelectionRange(start, start); } catch {}
});
try {
  onlineUrlInput.value = localStorage.getItem('keshiyon-online-url') || ONLINE_URL_DEFAULT;
} catch { onlineUrlInput.value = ONLINE_URL_DEFAULT; }
updateOnlineUI();

