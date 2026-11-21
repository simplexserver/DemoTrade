// Approval tokens for paper orders. Only the risk engine (js/engine/risk.js) issues them; the paper trader consumes them.
// A token is a frozen object registered in a module-level WeakSet, so a plain copy of its fields is not an approval.
// Each token is single use. Pure: no DOM, no storage, no clock. The caller passes every time in.

const issued = new WeakSet();
const used = new WeakSet();

// Only js/engine/risk.js may call this.
export function issueApproval(fields) {
  const obj = Object.freeze({ ...fields });
  issued.add(obj);
  return obj;
}

// True when the token was issued by the risk engine and has not been used yet.
export function isApproved(obj) {
  return Boolean(obj) && typeof obj === 'object' && issued.has(obj) && !used.has(obj);
}

// Marks a token used. Returns true the first time, false on any reuse or for a token that was never issued.
export function consumeApproval(obj) {
  if (!isApproved(obj)) return false;
  used.add(obj);
  return true;
}
