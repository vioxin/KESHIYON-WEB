export const COLS = 5;
export const MAX_ROWS = 6;

export class State {
  constructor(data = null) {
    if (data) {
      this.board = data.board.map((col) => col.slice());
      this.isCircleTurn = data.isCircleTurn;
      this.freed = data.freed;
      this.empty = data.empty;
      this.ptsO = data.ptsO;
      this.ptsX = data.ptsX;
      this.willDelete = data.willDelete;
      this.gameOver = data.gameOver;
    } else {
      this.board = Array.from({ length: COLS }, () => Array(MAX_ROWS).fill(' '));
      this.isCircleTurn = true;
      this.freed = 4;
      this.empty = 20;
      this.ptsO = 0;
      this.ptsX = 0;
      this.willDelete = false;
      this.gameOver = false;
    }
  }

  toJSON() {
    return {
      board: this.board.map((col) => col.slice()),
      isCircleTurn: this.isCircleTurn,
      freed: this.freed,
      empty: this.empty,
      ptsO: this.ptsO,
      ptsX: this.ptsX,
      willDelete: this.willDelete,
      gameOver: this.gameOver,
    };
  }

  copy() {
    return new State(this.toJSON());
  }

  moves() {
    const result = [];
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < this.freed; row++) {
        if (this.board[col][row] !== ' ') continue;
        if (row === 0 || this.board[col][row - 1] !== ' ') result.push([col, row]);
      }
    }
    return result;
  }

  apply(col, row) {
    const s = this.copy();
    if (!s.moves().some(([c, r]) => c === col && r === row)) {
      throw new Error('そのマスには置けません。');
    }
    s._setBlock(col, row);
    const { match, score } = s._checkFour();
    if (score > 0) s._handleScoring(match, score);
    s._checkExpand();
    return s;
  }

  _setBlock(col, row) {
    this.board[col][row] = this.isCircleTurn ? 'o' : 'x';
    this.isCircleTurn = !this.isCircleTurn;
    this.empty--;
  }

  _checkFour() {
    const match = new Set();
    let score = 0;
    const b = this.board;
    const f = this.freed;
    const key = (c, r) => `${c},${r}`;

    const line4 = (positions, prevPos = null) => {
      const vals = positions.map(([c, r]) => b[c][r]);
      const v = vals[0];
      if (v === ' ' || v === '^') return;
      if (!(vals[1] === v && vals[2] === v && vals[3] === v)) return;
      for (const [c, r] of positions) match.add(key(c, r));

      let isStart = true;
      if (prevPos) {
        const [pc, pr] = prevPos;
        if (pc >= 0 && pc < COLS && pr >= 0 && pr < f && b[pc][pr] === v) isStart = false;
      }
      if (isStart) score++;
    };

    for (let row = 0; row < f; row++) {
      for (let col = 0; col < 2; col++) {
        line4(Array.from({ length: 4 }, (_, i) => [col + i, row]), [col - 1, row]);
      }
    }
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < f - 3; row++) {
        line4(Array.from({ length: 4 }, (_, i) => [col, row + i]), [col, row - 1]);
      }
    }
    for (let col = 0; col < 2; col++) {
      for (let row = 0; row < f - 3; row++) {
        line4(Array.from({ length: 4 }, (_, i) => [col + i, row + i]), [col - 1, row - 1]);
      }
    }
    for (let col = 3; col < COLS; col++) {
      for (let row = 0; row < f - 3; row++) {
        line4(Array.from({ length: 4 }, (_, i) => [col - i, row + i]), [col + 1, row - 1]);
      }
    }
    return { match, score };
  }

  _handleScoring(match, score) {
    const b = this.board;
    const f = this.freed;
    if (this.willDelete) {
      const toDelete = new Set(match);
      for (const pos of match) {
        const [px, py] = pos.split(',').map(Number);
        for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx >= 0 && nx < COLS && ny >= 0 && ny < f && b[nx][ny] === '^') {
            toDelete.add(`${nx},${ny}`);
          }
        }
      }
      for (const pos of toDelete) {
        const [px, py] = pos.split(',').map(Number);
        if (b[px][py] !== ' ') {
          b[px][py] = ' ';
          this.empty++;
        }
      }
    } else {
      for (const pos of match) {
        const [px, py] = pos.split(',').map(Number);
        if (b[px][py] !== '^') b[px][py] = '^';
      }
    }

    // _setBlock has already changed the turn, so score the player who just moved.
    if (!this.isCircleTurn) this.ptsO += score;
    else this.ptsX += score;
    this.willDelete = !this.willDelete;
  }

  _checkExpand() {
    if (this.freed < MAX_ROWS && this.empty > 0 && this.empty <= 2 && this.ptsO === this.ptsX) {
      this.freed++;
      this.empty += COLS;
      return;
    }
    if (this.empty === 0) {
      if (!this.isCircleTurn) this.ptsO++;
      else this.ptsX++;
      if (this.freed < MAX_ROWS && this.ptsO === this.ptsX) {
        this.freed++;
        this.empty += COLS;
        return;
      }
      this.gameOver = true;
    }
  }
}
