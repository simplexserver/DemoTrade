// Storage consent. 'unset' until the banner is answered. Nothing optional is kept on this device
// unless the answer is 'accepted'. Every storage call is wrapped: blocked storage must never throw.
export const CONSENT_KEY = 'krabby.v2.consent';
export const CONSENT_VALUES = Object.freeze(['unset', 'accepted', 'declined']);

// storage: an object with getItem / setItem / removeItem (tests inject one). Left undefined, the
// browser localStorage is looked up on each call, so a page without storage still works.
export function createConsent({ storage } = {}) {
  let memory = 'unset';
  const backend = () => {
    try { return storage === undefined ? globalThis.localStorage || null : storage; } catch (_) { return null; }
  };
  const api = {
    get() {
      try {
        const s = backend();
        const v = s ? s.getItem(CONSENT_KEY) : null;
        if (v === 'accepted' || v === 'declined') return v;
      } catch (_) { /* fall through to the in-memory answer */ }
      return memory;
    },
    // Returns true when the value was valid. The answer is also kept in memory for this page.
    set(value) {
      if (!CONSENT_VALUES.includes(value)) return false;
      memory = value;
      try {
        const s = backend();
        if (s) {
          if (value === 'unset') s.removeItem(CONSENT_KEY);
          else s.setItem(CONSENT_KEY, value);
        }
      } catch (_) { /* memory still holds the answer */ }
      return true;
    },
    allowsStorage() {
      return api.get() === 'accepted';
    },
  };
  return api;
}

export const consent = createConsent();
