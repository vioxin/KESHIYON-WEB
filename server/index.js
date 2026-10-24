import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { State } from '../game.js';

const PORT = Number(process.env.PORT || 10000);
const SHEETS_ENDPOINT = String(process.env.SHEETS_ENDPOINT || '').trim();
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily confused I/O/0/1
const MAX_ROOMS = 1000;
const MAX_MESSAGE_BYTES = 8192;
const MAX_MESSAGES_PER_10_SECONDS = 80;
const WAITING_ROOM_TTL_MS = 5 * 60 * 1000;
const FINISHED_ROOM_TTL_MS = 15 * 60 * 1000;

const rooms = new Map();
const matchmakingQueue = [];
const clients = new Set();

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function roomError(ws, message, code = 'ROOM_ERROR') {
  send(ws, { type: 'room_error', code, message });
}

function roomCodeExists(code) { return rooms.has(code); }
function makeRoomCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const bytes = randomBytes(6);
    let code = '';
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (!roomCodeExists(code)) return code;
  }
  throw new Error('ルームコードを生成できませんでした。');
}

function makeRoom(first, second = null) {
  if (rooms.size >= MAX_ROOMS) throw new Error('ルーム数が上限に達しています。しばらくしてから試してください。');
  const code = makeRoomCode();
  const room = {
    code,
    players: [first, second],
    state: new State(),
    moves: [],
    status: second ? 'playing' : 'waiting',
    matchId: randomUUID(),
    rematchVotes: new Set(),
    createdAt: Date.now(),
    finishedAt: null,
    recordStatus: 'pending',
    recordStarted: false,
  };
  rooms.set(code, room);
  first.roomCode = code;
  first.seat = 0;
  first.matchmaking = false;
  if (second) {
    second.roomCode = code;
    second.seat = 1;
    second.matchmaking = false;
  }
  return room;
}

function roomSnapshot(room, ws, extra = {}) {
  return {
    type: 'room_update',
    roomCode: room.code,
    seat: room.players.indexOf(ws),
    state: room.state.toJSON(),
    moves: room.moves,
    status: room.status,
    matchId: room.matchId,
    rematchVotes: room.rematchVotes.size,
    recordStatus: room.recordStatus,
    ...extra,
  };
}

function broadcastRoom(room, extra = {}) {
  for (const player of room.players) {
    if (player && player.readyState === WebSocket.OPEN) send(player, roomSnapshot(room, player, extra));
  }
}

function announceRoom(room, message) {
  for (const player of room.players) if (player) send(player, message);
}

function removeFromQueue(ws) {
  ws.matchmaking = false;
  for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
    if (matchmakingQueue[i] === ws) matchmakingQueue.splice(i, 1);
  }
}

function endRoom(room, leavingClient = null, reason = 'opponent_left') {
  if (!room) return;
  rooms.delete(room.code);
  for (const player of room.players) {
    if (!player) continue;
    player.roomCode = null;
    player.seat = null;
    if (player !== leavingClient) send(player, { type: reason, roomCode: room.code });
  }
}

function leaveRoom(ws, notify = true) {
  removeFromQueue(ws);
  const code = ws.roomCode;
  if (!code) {
    if (notify) send(ws, { type: 'room_left' });
    return;
  }
  const room = rooms.get(code);
  if (!room) {
    ws.roomCode = null;
    ws.seat = null;
    if (notify) send(ws, { type: 'room_left' });
    return;
  }
  endRoom(room, ws, 'opponent_left');
  ws.roomCode = null;
  ws.seat = null;
  if (notify) send(ws, { type: 'room_left', roomCode: code });
}

function requireNoRoom(ws) {
  if (ws.roomCode) {
    roomError(ws, 'すでにルームに参加しています。先に退出してください。', 'ALREADY_IN_ROOM');
    return false;
  }
  return true;
}

function createRoomForClient(ws) {
  if (!requireNoRoom(ws)) return;
  removeFromQueue(ws);
  try {
    const room = makeRoom(ws);
    send(ws, {
      type: 'room_created', roomCode: room.code, seat: 0,
      state: room.state.toJSON(), moves: [], status: 'waiting', matchId: room.matchId,
    });
  } catch (error) {
    roomError(ws, error.message || String(error), 'ROOM_LIMIT');
  }
}

function joinRoom(ws, rawCode) {
  if (!requireNoRoom(ws)) return;
  removeFromQueue(ws);
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (code.length !== 6) return roomError(ws, '6文字のルームコードを入力してください。', 'INVALID_CODE');
  const room = rooms.get(code);
  if (!room || room.status !== 'waiting' || room.players[1]) {
    return roomError(ws, 'ルームが見つからないか、すでに対戦が始まっています。コードを確認してください。', 'ROOM_NOT_AVAILABLE');
  }
  room.players[1] = ws;
  room.status = 'playing';
  room.createdAt = Date.now();
  ws.roomCode = room.code;
  ws.seat = 1;
  ws.matchmaking = false;
  send(ws, {
    type: 'room_joined', roomCode: room.code, seat: 1,
    state: room.state.toJSON(), moves: room.moves, status: room.status, matchId: room.matchId,
  });
  broadcastRoom(room);
}

function quickMatch(ws) {
  if (!requireNoRoom(ws)) return;
  removeFromQueue(ws);
  let opponent = null;
  while (matchmakingQueue.length) {
    const candidate = matchmakingQueue.shift();
    if (candidate && candidate !== ws && candidate.readyState === WebSocket.OPEN && candidate.matchmaking && !candidate.roomCode) {
      candidate.matchmaking = false;
      opponent = candidate;
      break;
    }
  }
  if (!opponent) {
    ws.matchmaking = true;
    matchmakingQueue.push(ws);
    send(ws, { type: 'matchmaking_wait', queueLength: matchmakingQueue.length });
    return;
  }
  try {
    const room = makeRoom(opponent, ws);
    send(opponent, { type: 'match_found', roomCode: room.code, seat: 0, state: room.state.toJSON(), moves: [], status: 'playing', matchId: room.matchId });
    send(ws, { type: 'match_found', roomCode: room.code, seat: 1, state: room.state.toJSON(), moves: [], status: 'playing', matchId: room.matchId });
    broadcastRoom(room);
  } catch (error) {
    roomError(opponent, error.message || String(error), 'ROOM_LIMIT');
    roomError(ws, error.message || String(error), 'ROOM_LIMIT');
  }
}

function handleMove(ws, message) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room || room.status !== 'playing') return roomError(ws, '対局中のルームに参加していません。', 'NOT_PLAYING');
  if (ws.seat !== (room.state.isCircleTurn ? 0 : 1)) return roomError(ws, 'まだあなたの番ではありません。', 'NOT_YOUR_TURN');
  const col = Number(message.col), row = Number(message.row);
  if (!Number.isInteger(col) || !Number.isInteger(row) || !room.state.moves().some(([c, r]) => c === col && r === row)) {
    return roomError(ws, 'そのマスには置けません。盤面を更新してから再試行してください。', 'ILLEGAL_MOVE');
  }
  const seat = ws.seat;
  room.state = room.state.apply(col, row);
  room.moves.push([col, row]);
  if (room.state.gameOver) {
    room.status = 'finished';
    room.finishedAt = Date.now();
    room.rematchVotes.clear();
    const diff = room.state.ptsO - room.state.ptsX;
    room.recordStatus = diff === 0 ? 'draw' : 'saving';
    broadcastRoom(room, { lastMove: { move: [col, row], seat } });
    if (diff === 0) {
      announceRoom(room, { type: 'record_status', status: 'draw', message: '引き分けは記録対象外です。' });
    } else {
      void saveCompletedMatch(room);
    }
    return;
  }
  broadcastRoom(room, { lastMove: { move: [col, row], seat } });
}

async function saveCompletedMatch(room) {
  if (room.recordStarted) return;
  room.recordStarted = true;
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(SHEETS_ENDPOINT)) {
    room.recordStatus = 'not_configured';
    announceRoom(room, { type: 'record_status', status: 'not_configured', message: 'RenderのSHEETS_ENDPOINT環境変数が未設定です。' });
    return;
  }
  const payload = {
    version: 1,
    matchId: room.matchId,
    moves: room.moves.map(([col, row]) => [col, row]),
    moveCount: room.moves.length,
    ptsO: room.state.ptsO,
    ptsX: room.state.ptsX,
    p1Type: 'online',
    p2Type: 'online',
  };
  try {
    const response = await fetch(SHEETS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    const text = await response.text();
    let result = null;
    try { result = JSON.parse(text); } catch { /* handled below */ }
    if (!response.ok || !result || result.ok !== true || !(result.saved || result.duplicate)) {
      throw new Error(`Apps Script response ${response.status}: ${text.slice(0, 240)}`);
    }
    room.recordStatus = 'saved';
    announceRoom(room, { type: 'record_status', status: 'saved', duplicate: Boolean(result.duplicate), message: '対局を共有スプレッドシートに保存しました。' });
  } catch (error) {
    room.recordStatus = 'error';
    console.error('Google Sheets save failed:', error);
    announceRoom(room, { type: 'record_status', status: 'error', message: 'Google Sheetsへの保存に失敗しました。SHEETS_ENDPOINTとApps Scriptの公開設定を確認してください。' });
  }
}

function requestRematch(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room || room.status !== 'finished') return roomError(ws, '再戦は対局終了後に申し込めます。', 'MATCH_NOT_FINISHED');
  room.rematchVotes.add(ws.seat);
  announceRoom(room, { type: 'rematch_wait', votes: room.rematchVotes.size, required: 2 });
  if (room.rematchVotes.size < 2) return;
  room.state = new State();
  room.moves = [];
  room.status = 'playing';
  room.matchId = randomUUID();
  room.rematchVotes.clear();
  room.createdAt = Date.now();
  room.finishedAt = null;
  room.recordStatus = 'pending';
  room.recordStarted = false;
  broadcastRoom(room, { rematch: true });
}

function handleMessage(ws, raw) {
  if (raw.length > MAX_MESSAGE_BYTES) return roomError(ws, 'メッセージが大きすぎます。', 'MESSAGE_TOO_LARGE');
  const now = Date.now();
  ws.messageTimes = (ws.messageTimes || []).filter((t) => now - t < 10_000);
  ws.messageTimes.push(now);
  if (ws.messageTimes.length > MAX_MESSAGES_PER_10_SECONDS) return roomError(ws, '送信頻度が高すぎます。少し待ってください。', 'RATE_LIMIT');
  let message;
  try { message = JSON.parse(raw.toString()); }
  catch { return roomError(ws, 'JSONメッセージを読み取れません。', 'INVALID_JSON'); }
  if (!message || typeof message.type !== 'string') return roomError(ws, 'メッセージ形式が不正です。', 'INVALID_MESSAGE');
  switch (message.type) {
    case 'hello': send(ws, { type: 'connected', version: 1 }); break;
    case 'create_room': createRoomForClient(ws); break;
    case 'join_room': joinRoom(ws, message.roomCode); break;
    case 'quick_match': quickMatch(ws); break;
    case 'move': handleMove(ws, message); break;
    case 'rematch_request': requestRematch(ws); break;
    case 'leave_room': leaveRoom(ws, true); break;
    case 'cancel_matchmaking': removeFromQueue(ws); send(ws, { type: 'matchmaking_cancelled' }); break;
    case 'pong': break;
    default: roomError(ws, '未対応の操作です。', 'UNKNOWN_ACTION');
  }
}

function healthPayload() {
  return {
    ok: true,
    service: 'KESHIYON online server',
    uptimeSeconds: Math.floor(process.uptime()),
    activeRooms: rooms.size,
    waitingPlayers: matchmakingQueue.filter((ws) => ws && ws.readyState === WebSocket.OPEN && ws.matchmaking).length,
    spreadsheetConfigured: /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:\?.*)?$/.test(SHEETS_ENDPOINT),
    time: new Date().toISOString(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
    const payload = JSON.stringify(healthPayload());
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(payload);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Not found. Health check: /healthz; WebSocket: /ws');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.seat = null;
  ws.matchmaking = false;
  ws.isAlive = true;
  ws.messageTimes = [];
  clients.add(ws);
  send(ws, { type: 'connected', version: 1 });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => handleMessage(ws, data));
  ws.on('error', (error) => console.warn('WebSocket client error:', error.message));
  ws.on('close', () => {
    removeFromQueue(ws);
    if (ws.roomCode) leaveRoom(ws, false);
    clients.delete(ws);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { ws.terminate(); }
  }
}, 30_000);

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === 'waiting' && now - room.createdAt > WAITING_ROOM_TTL_MS) {
      for (const player of room.players) if (player) send(player, { type: 'room_expired', roomCode: room.code });
      endRoom(room, null, 'room_expired');
    } else if (room.status === 'finished' && room.finishedAt && now - room.finishedAt > FINISHED_ROOM_TTL_MS) {
      endRoom(room, null, 'room_expired');
    }
  }
  for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
    const ws = matchmakingQueue[i];
    if (!ws || ws.readyState !== WebSocket.OPEN || !ws.matchmaking || ws.roomCode) matchmakingQueue.splice(i, 1);
  }
}, 30_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KESHIYON online server listening on port ${PORT}`);
  console.log(`Google Sheets recorder: ${SHEETS_ENDPOINT ? 'configured' : 'NOT configured'}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(cleanup);
  for (const ws of clients) ws.close(1001, 'Server is shutting down');
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
