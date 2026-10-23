import { State } from './game.js';
import { findBestMove } from './ai.js';

self.onmessage = (event) => {
  const { state, params } = event.data;
  try {
    const result = findBestMove(new State(state), params, (progress) => {
      self.postMessage({ type: 'progress', progress });
    });
    self.postMessage({ type: 'done', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
