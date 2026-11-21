// SimpleXEngine roles: what the bot may do in the app. Pure: the role comes from the settings object passed in
// (settings.engine.roleId), not from a store. The bot never changes its own role, the connection, secrets,
// the real-money lock or the journal.

export const CAPABILITIES = Object.freeze(['navigate', 'settings.display', 'settings.methods', 'risk.tighten', 'brain.learn', 'trade.place']);

export const ROLES = Object.freeze([
  {
    id: 'observer', label: 'Observer',
    summary: 'Opens tabs so you can see what it is looking at. Changes no settings and places no trade.',
    caps: Object.freeze(['navigate']),
  },
  {
    id: 'trainer', label: 'Trainer',
    summary: 'Opens tabs, changes display settings and lets the brain learn. It never places a trade.',
    caps: Object.freeze(['navigate', 'settings.display', 'brain.learn']),
  },
  {
    id: 'operator', label: 'Operator',
    summary: 'Everything above, plus method settings, switching risk controls on, and placing paper trades while SimpleXEngine is switched on and started.',
    caps: CAPABILITIES,
  },
]);

const ROLE_BY_ID = Object.freeze(Object.fromEntries(ROLES.map((r) => [r.id, r])));

// Paths the bot never writes, whatever its role. Matched case-insensitively.
const FORBIDDEN = /token|secret|appid|journal/i;
// Stake and sizing stay under the user's control, even on methods the bot may switch.
const STAKE_LIKE = /(^|\.)(stake|percent|sizing)(\.|$)/;

// The role in force. A missing or unknown role gives the least powerful one (fails closed).
export function roleOf(settings) {
  const id = settings && settings.engine ? settings.engine.roleId : undefined;
  return ROLE_BY_ID[id] || ROLE_BY_ID.observer;
}

export function can(cap, settings) {
  return roleOf(settings).caps.includes(cap);
}

// The capability a settings path needs, or null when the bot may never write it.
function capabilityFor(path) {
  if (path.startsWith('settings.format') || path.startsWith('settings.appearance')) return 'settings.display';
  if (path.startsWith('settings.ui') || path.startsWith('settings.trade') || path.startsWith('settings.orders')) return 'settings.display';
  if (path.startsWith('bot.cursor')) return 'settings.display';
  if (path.startsWith('bot.brain')) return 'brain.learn';
  if (path.startsWith('auto.') || path.startsWith('basket.')) return 'settings.methods';
  return null;
}

// Verdict for one write the bot wants to make: {ok: true} or {ok: false, reason}.
// Risk controls: the bot may switch a control on (tightening), never off, and never change its value.
export function allowedWrite(path, value, settings) {
  const p = String(path || '');
  const role = roleOf(settings);
  if (!p) return { ok: false, reason: 'No setting was named.' };
  if (p === 'bot.enabled' || p === 'bot.roleId' || p === 'engine.roleId') return { ok: false, reason: 'SimpleXEngine cannot change its own switch or role.' };
  if (p === 'engine.liveEnabled' || p === 'engine.aiEnabled') return { ok: false, reason: 'SimpleXEngine cannot change a locked switch.' };
  if (p.startsWith('settings.connection') || p.startsWith('conn.')) return { ok: false, reason: 'SimpleXEngine cannot change the connection.' };
  if (p.startsWith('risk.allowReal')) return { ok: false, reason: 'SimpleXEngine cannot change real-money trading.' };
  if (FORBIDDEN.test(p)) return { ok: false, reason: `SimpleXEngine cannot change ${p}.` };
  if (STAKE_LIKE.test(p)) return { ok: false, reason: `Stake and sizing stay under your control. SimpleXEngine cannot change ${p}.` };

  if (p.startsWith('risk.')) {
    if (!/^risk\.[A-Za-z]+\.on$/.test(p)) return { ok: false, reason: 'SimpleXEngine can only switch a risk control on. It cannot change its value.' };
    if (value !== true) return { ok: false, reason: 'SimpleXEngine can only tighten risk: it may switch a control on, never off.' };
    if (!role.caps.includes('risk.tighten')) return { ok: false, reason: `${role.label} cannot tighten risk controls.` };
    return { ok: true };
  }

  // The brain gate only tightens: SimpleXEngine may switch the brain on or require agreement, never switch either off.
  if (p === 'bot.brain.on' || p === 'bot.brain.requireAgreement') {
    if (value !== true) return { ok: false, reason: 'SimpleXEngine cannot switch its brain gate off.' };
  }

  const cap = capabilityFor(p);
  if (!cap) return { ok: false, reason: `SimpleXEngine cannot change ${p}.` };
  if (!role.caps.includes(cap)) return { ok: false, reason: `${role.label} cannot change ${p}.` };
  return { ok: true };
}
