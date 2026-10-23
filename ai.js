import { COLS, MAX_ROWS, State } from './game.js';

export const DEFAULT_PARAMS = Object.freeze({
  timeLimit: 5,
  wScore: 2000,
  wThree: 500,
  wTwo: 50,
  wOne: 5,
  wCenter: 8,
  wExpand: 300,
});

export function evaluateWithParams(s, p) {
  if (s.gameOver) {
    const diff = s.ptsO - s.ptsX;
    if (diff > 0) return 100000 + diff;
    if (diff < 0) return -100000 + diff;
    return 0;
  }

  let score = (s.ptsO - s.ptsX) * p.wScore;
  const b = s.board;
  const f = s.freed;

  const scoreWindow = (cells) => {
    const vals = cells.map(([c, r]) => b[c][r]);
    const oCount = vals.filter((v) => v === 'o').length;
    const xCount = vals.filter((v) => v === 'x').length;
    const emptyCount = vals.filter((v) => v === ' ').length;
    if (oCount > 0 && xCount > 0) return 0;
    if (oCount === 0 && xCount === 0) return 0;
    const sign = oCount > 0 ? 1 : -1;
    const n = oCount > 0 ? oCount : xCount;
    if (n === 3 && emptyCount >= 1) return sign * p.wThree;
    if (n === 2 && emptyCount >= 2) return sign * p.wTwo;
    if (n === 1 && emptyCount >= 3) return sign * p.wOne;
    return 0;
  };

  for (let row = 0; row < f; row++) {
    for (let col = 0; col < 2; col++) {
      score += scoreWindow(Array.from({ length: 4 }, (_, i) => [col + i, row]));
    }
  }
  for (let col = 0; col < COLS; col++) {
    for (let row = 0; row < f - 3; row++) {
      score += scoreWindow(Array.from({ length: 4 }, (_, i) => [col, row + i]));
    }
  }
  for (let col = 0; col < 2; col++) {
    for (let row = 0; row < f - 3; row++) {
      score += scoreWindow(Array.from({ length: 4 }, (_, i) => [col + i, row + i]));
    }
  }
  for (let col = 3; col < COLS; col++) {
    for (let row = 0; row < f - 3; row++) {
      score += scoreWindow(Array.from({ length: 4 }, (_, i) => [col - i, row + i]));
    }
  }

  for (let row = 0; row < f; row++) {
    if (b[2][row] === 'o') score += p.wCenter;
    else if (b[2][row] === 'x') score -= p.wCenter;
  }
  if (s.freed < MAX_ROWS && s.empty <= 4) {
    const diff = s.ptsO - s.ptsX;
    if (diff !== 0) score += diff * p.wExpand;
  }
  return score;
}

const INF = Number.POSITIVE_INFINITY;

export function findBestMove(startState, params = DEFAULT_PARAMS, onProgress = () => {}) {
  const s = startState instanceof State ? startState : new State(startState);
  const startedAt = Date.now();
  const timeLimitMs = Math.max(100, Number(params.timeLimit ?? 5) * 1000);
  let timedOut = false;
  let nodes = 0;
  const tt = new Map();

  const elapsed = () => (Date.now() - startedAt) / 1000;
  const timeUp = () => {
    if ((nodes & 255) === 0 && Date.now() - startedAt > timeLimitMs) timedOut = true;
    return timedOut;
  };
  const stateKey = (st) => {
    let boardString = '';
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < MAX_ROWS; row++) {
        const v = st.board[col][row];
        boardString += v === ' ' ? '_' : v;
      }
    }
    return `${boardString}|${st.isCircleTurn ? 1 : 0}|${st.freed}|${st.empty}|${st.ptsO}|${st.ptsX}|${st.willDelete ? 1 : 0}|${st.gameOver ? 1 : 0}`;
  };
  const orderMoves = (moves) => moves.slice().sort((a, b) => (Math.abs(a[0] - 2) - Math.abs(b[0] - 2)) || (a[1] - b[1]));

  const ab = (st, depth, alpha, beta, maxi) => {
    nodes++;
    if (timeUp() || st.gameOver || depth === 0) return evaluateWithParams(st, params);

    const key = `${stateKey(st)}|d${depth}`;
    if (tt.has(key)) return tt.get(key);
    const moves = st.moves();
    if (!moves.length) return evaluateWithParams(st, params);

    let best = maxi ? -INF : INF;
    for (const [col, row] of orderMoves(moves)) {
      if (timeUp()) break;
      const next = st.apply(col, row);
      const val = ab(next, depth - 1, alpha, beta, next.isCircleTurn);
      if (maxi) {
        if (val > best) best = val;
        alpha = Math.max(alpha, best);
      } else {
        if (val < best) best = val;
        beta = Math.min(beta, best);
      }
      if (beta <= alpha) break;
    }
    if (Number.isFinite(best)) tt.set(key, best);
    if (tt.size > 180000) tt.clear();
    return best;
  };

  const moves = s.moves();
  if (!moves.length) return { move: null, depth: 0, value: 0, nodes, elapsed: elapsed() };
  if (moves.length === 1) return { move: moves[0], depth: 1, value: 0, nodes, elapsed: elapsed() };

  let bestMove = moves[0];
  let lastValue = 0;
  let lastDepth = 0;
  const maxi = s.isCircleTurn;
  for (let depth = 1; depth < 60; depth++) {
    if (timedOut || Date.now() - startedAt > timeLimitMs) break;
    let depthBestMove = null;
    let depthBestValue = maxi ? -INF : INF;
    for (const [col, row] of orderMoves(moves)) {
      if (timeUp()) break;
      const next = s.apply(col, row);
      const val = ab(next, depth - 1, -INF, INF, next.isCircleTurn);
      if (maxi && val > depthBestValue) {
        depthBestValue = val;
        depthBestMove = [col, row];
      } else if (!maxi && val < depthBestValue) {
        depthBestValue = val;
        depthBestMove = [col, row];
      }
    }
    if (!timedOut && depthBestMove) {
      bestMove = depthBestMove;
      lastValue = depthBestValue;
      lastDepth = depth;
    }
    onProgress({ depth, move: bestMove, value: depthBestValue, nodes, elapsed: elapsed() });
    if (timedOut || Date.now() - startedAt > timeLimitMs) break;
  }
  return { move: bestMove, depth: lastDepth, value: lastValue, nodes, elapsed: elapsed() };
}
