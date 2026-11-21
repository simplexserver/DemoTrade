// AI: an OFF stub. The AI coding assistant is off in this build (D12). It makes no call and holds no key.
// Pure: no DOM, storage, network or clock.
export const ENGINE = Object.freeze({
  code: 'AI', name: 'AI coding assistant', stage: 3, status: 'off', prefix: 'ai', topics: [],
  run: () => [],
});

export const aiStatus = () => ({ status: 'off', reason: 'Off in the first build. It needs your own provider and key, which this build does not hold.' });

export function aiSuggest() {
  throw new Error('The AI assistant is off in this build.');
}
