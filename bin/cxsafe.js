#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline/promises');
const { spawn, spawnSync } = require('node:child_process');

const STORE_VERSION = 1;
const SAFE_STORE_NAME = 'codexm-accounts.json';
const SESSION_STORE_NAME = 'codexm-sessions.json';
const CODEXS_STORE_NAME = 'codex-accounts.json';
const AUTH_FILE_NAME = 'auth.json';
const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
const REFRESH_ENDPOINT = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_GRACE_SECONDS = 24 * 60 * 60;
const SESSION_HEARTBEAT_MS = 30 * 1000;
const SESSION_STALE_MS = 12 * 60 * 60 * 1000;
const FIVE_HOURS_SECONDS = 5 * 60 * 60;
const LIMITED_REMAINING_PERCENT = 3;
const DEFAULT_TIME_ZONE = 'Asia/Singapore';

const STATES = Object.freeze({
  AVAILABLE: 'available',
  LIMITED: 'limited',
  COOLING: 'cooling',
  IN_USE: 'in-use',
  OFFLINE: 'offline',
  UNKNOWN: 'unknown',
});

function normalizeWindowsHome(value) {
  if (!value) return value;
  const match = value.match(/^\/([a-zA-Z])(\/.*)?$/);
  if (!match) return value;
  return `${match[1].toUpperCase()}:${(match[2] || '').replace(/\//g, '\\')}`;
}

function getHomeDir(env = process.env) {
  if (process.platform !== 'win32') return env.HOME || os.homedir();
  return env.USERPROFILE
    || (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : '')
    || normalizeWindowsHome(env.HOME)
    || os.homedir();
}

function getCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(getHomeDir(env), '.codex');
}

function getSafeStorePath(env = process.env) {
  return env.CODEXM_STORE || env.CODEX_SAFE_STORE || path.join(getCodexHome(env), SAFE_STORE_NAME);
}

function getSessionStorePath(env = process.env) {
  return env.CODEXM_SESSION_STORE
    || env.CODEX_SAFE_SESSION_STORE
    || path.join(path.dirname(getSafeStorePath(env)), SESSION_STORE_NAME);
}

function getCodexsStorePath(env = process.env) {
  return path.join(getCodexHome(env), CODEXS_STORE_NAME);
}

function getAuthPath(env = process.env) {
  return path.join(getCodexHome(env), AUTH_FILE_NAME);
}

function assertNotSymlink(targetPath, reason) {
  if (!fs.existsSync(targetPath)) return;
  if (fs.lstatSync(targetPath).isSymbolicLink()) {
    throw new Error(`${reason}: ${targetPath}`);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  assertNotSymlink(dirPath, 'refusing to use symlink directory');
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch (_) {
    // Windows commonly ignores POSIX modes.
  }
}

function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  assertNotSymlink(path.dirname(filePath), 'refusing to read through symlink directory');
  assertNotSymlink(filePath, 'refusing to read symlink file');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeFileAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  assertNotSymlink(dir, 'refusing to write through symlink directory');
  assertNotSymlink(filePath, 'refusing to overwrite symlink file');

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`,
  );

  let cleanup = true;
  try {
    const fd = fs.openSync(tempPath, 'wx', 0o600);
    try {
      fs.writeSync(fd, text);
      try {
        fs.fsyncSync(fd);
      } catch (_) {
        // Some filesystems do not support fsync here.
      }
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch (_) {
      // Windows commonly ignores POSIX modes.
    }
    fs.renameSync(tempPath, filePath);
    cleanup = false;
  } finally {
    if (cleanup) {
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    return JSON.parse(decodeBase64Url(payload));
  } catch (_) {
    return null;
  }
}

function readAuthFromPath(authPath) {
  const auth = readJsonFile(authPath, null);
  if (!auth) return null;
  if (!auth.tokens || typeof auth.tokens !== 'object') {
    throw new Error(`auth file has no tokens object: ${authPath}`);
  }
  return auth;
}

function readActiveAuth(env = process.env) {
  return readAuthFromPath(getAuthPath(env));
}

function accountEmail(auth) {
  const payload = decodeJwtPayload(auth && auth.tokens && auth.tokens.id_token);
  return payload && typeof payload.email === 'string' ? payload.email : '';
}

function accountShortId(auth) {
  const accountId = auth && auth.tokens && auth.tokens.account_id;
  return typeof accountId === 'string' && accountId.length >= 8 ? accountId.slice(0, 8) : '';
}

function accountIdForStore(auth) {
  const email = accountEmail(auth);
  const shortId = accountShortId(auth);
  return email || shortId;
}

function normalizeAccount(auth, source = 'unknown') {
  if (!auth || !auth.tokens) throw new Error('missing auth tokens');
  const id = accountIdForStore(auth);
  if (!id) throw new Error('cannot derive account label from id_token email or account_id');
  const email = accountEmail(auth);
  const shortId = accountShortId(auth);
  const now = new Date().toISOString();
  return {
    id,
    email,
    shortId,
    label: email || shortId,
    source,
    updatedAt: now,
    auth,
  };
}

function displayAccount(account) {
  return account.label || account.email || account.shortId || account.id;
}

function readSafeStore(env = process.env) {
  const storePath = getSafeStorePath(env);
  const store = readJsonFile(storePath, null);
  if (!store) return [];
  if (!store || store.version !== STORE_VERSION || !Array.isArray(store.accounts)) {
    throw new Error(`invalid store format: ${storePath}`);
  }
  return store.accounts.map((item) => normalizeAccount(item.auth, item.source || 'safe-store'));
}

function writeSafeStore(accounts, env = process.env) {
  const seen = new Set();
  const normalized = [];
  for (const account of accounts.map((item) => normalizeAccount(item.auth, item.source || 'safe-store'))) {
    const key = account.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(account);
  }
  normalized.sort((a, b) => displayAccount(a).localeCompare(displayAccount(b), 'en'));
  writeFileAtomic(getSafeStorePath(env), `${JSON.stringify({
    version: STORE_VERSION,
    accounts: normalized,
  }, null, 2)}\n`);
}


function numericEnv(env, name, fallback) {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sessionStaleMs(env = process.env) {
  return numericEnv(env, 'CODEXM_SESSION_STALE_MS', SESSION_STALE_MS);
}

function sessionHeartbeatMs(env = process.env) {
  return numericEnv(env, 'CODEXM_SESSION_HEARTBEAT_MS', SESSION_HEARTBEAT_MS);
}

function normalizeSession(session) {
  if (!session || typeof session !== 'object') return null;
  if (!session.id || !session.accountId) return null;
  return {
    id: String(session.id),
    accountId: String(session.accountId),
    label: String(session.label || session.accountId),
    pid: Number(session.pid) || 0,
    host: String(session.host || ''),
    platform: String(session.platform || ''),
    codexHome: String(session.codexHome || ''),
    startedAt: String(session.startedAt || session.updatedAt || ''),
    updatedAt: String(session.updatedAt || session.startedAt || ''),
  };
}

function pruneSessions(sessions, env = process.env) {
  const now = Date.now();
  const staleMs = sessionStaleMs(env);
  return sessions.filter((session) => {
    const updated = Date.parse(session.updatedAt);
    return Number.isFinite(updated) && now - updated <= staleMs;
  });
}

function readSessionStore(env = process.env) {
  const storePath = getSessionStorePath(env);
  const store = readJsonFile(storePath, null);
  if (!store) return [];
  if (!store || store.version !== STORE_VERSION || !Array.isArray(store.sessions)) return [];
  return pruneSessions(store.sessions.map(normalizeSession).filter(Boolean), env);
}

function writeSessionStore(sessions, env = process.env) {
  const seen = new Set();
  const normalized = [];
  for (const session of pruneSessions(sessions.map(normalizeSession).filter(Boolean), env)) {
    const key = session.id;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(session);
  }
  writeFileAtomic(getSessionStorePath(env), JSON.stringify({
    version: STORE_VERSION,
    sessions: normalized,
  }, null, 2) + '\n');
}

function sessionsByAccount(env = process.env) {
  const byId = new Map();
  for (const session of readSessionStore(env)) {
    const key = session.accountId.toLowerCase();
    if (!byId.has(key)) byId.set(key, session);
  }
  return byId;
}

function sessionSummary(session) {
  if (!session) return '';
  const parts = [];
  if (session.host) parts.push(session.host);
  if (session.pid) parts.push('pid ' + session.pid);
  return parts.join(' ');
}

function createSessionLease(account, env = process.env, output = process.stderr) {
  const startedAt = new Date().toISOString();
  const lease = {
    id: [os.hostname(), process.pid, Date.now().toString(36), Math.random().toString(36).slice(2)].join('-'),
    accountId: account.id,
    label: displayAccount(account),
    pid: process.pid,
    host: os.hostname(),
    platform: process.platform,
    codexHome: getCodexHome(env),
    startedAt,
    updatedAt: startedAt,
  };

  const save = () => {
    lease.updatedAt = new Date().toISOString();
    const sessions = readSessionStore(env).filter((session) => session.id !== lease.id);
    writeSessionStore([...sessions, lease], env);
  };

  save();
  return {
    lease,
    touch() {
      try {
        save();
      } catch (_) {}
    },
    release() {
      try {
        const sessions = readSessionStore(env).filter((session) => session.id !== lease.id);
        writeSessionStore(sessions, env);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        output.write('warning: failed to clear codexm session lease: ' + message + '\n');
      }
    },
  };
}

function upsertAccount(auth, env = process.env, source = 'manual') {
  const next = normalizeAccount(auth, source);
  const current = readSafeStore(env);
  const remaining = current.filter((account) => account.id.toLowerCase() !== next.id.toLowerCase());
  const overwritten = remaining.length !== current.length;
  writeSafeStore([...remaining, next], env);
  return { account: next, overwritten };
}

function activeLabel(env = process.env) {
  try {
    const auth = readActiveAuth(env);
    return auth ? accountIdForStore(auth) : '';
  } catch (_) {
    return '';
  }
}
function sameAuthTokens(left, right) {
  return JSON.stringify((left && left.tokens) || {}) === JSON.stringify((right && right.tokens) || {});
}

function syncActiveAuthFromStore(accounts, env = process.env) {
  const active = activeLabel(env).toLowerCase();
  if (!active) return false;
  const account = accounts.find((item) => item.id && item.id.toLowerCase() === active);
  if (!account || !account.auth) return false;
  let current;
  try {
    current = readActiveAuth(env);
  } catch (_) {
    return false;
  }
  if (!current || sameAuthTokens(current, account.auth)) return false;
  writeFileAtomic(getAuthPath(env), JSON.stringify(account.auth, null, 2) + '\n');
  return true;
}

function upsertActiveAuthIfChanged(beforeAuth, env = process.env, source = 'active-sync') {
  let current;
  try {
    current = readActiveAuth(env);
  } catch (_) {
    return false;
  }
  if (!current || sameAuthTokens(current, beforeAuth)) return false;
  upsertAccount(current, env, source);
  return true;
}

function rememberActiveAuthIfMissing(env = process.env, source = 'pre-switch-backup') {
  let current;
  try {
    current = readActiveAuth(env);
  } catch (_) {
    return false;
  }
  if (!current) return false;
  let account;
  try {
    account = normalizeAccount(current, source);
  } catch (_) {
    return false;
  }
  const accounts = readSafeStore(env);
  if (accounts.some((item) => item.id && item.id.toLowerCase() === account.id.toLowerCase())) return false;
  writeSafeStore([...accounts, account], env);
  return true;
}

function resolveAccount(selector, accounts) {
  if (!selector) throw new Error('missing account selector');
  if (/^\d+$/.test(selector)) {
    const index = Number(selector);
    if (index < 1 || index > accounts.length) {
      throw new Error(`account index does not exist: ${selector}`);
    }
    return accounts[index - 1];
  }
  return accounts.find((account) => {
    const values = [account.id, account.email, account.shortId, displayAccount(account)].filter(Boolean);
    return values.some((value) => value.toLowerCase() === selector.toLowerCase());
  }) || null;
}

function hasAccessFields(account) {
  const tokens = account && account.auth && account.auth.tokens;
  return Boolean(tokens && typeof tokens.access_token === 'string' && typeof tokens.account_id === 'string');
}

function accessTokenExpiresWithin(auth, skewSeconds = 60, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = decodeJwtPayload(auth && auth.tokens && auth.tokens.access_token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp - nowSeconds <= skewSeconds;
}

function tokenExpiresSoon(auth, nowSeconds = Math.floor(Date.now() / 1000)) {
  return accessTokenExpiresWithin(auth, REFRESH_GRACE_SECONDS, nowSeconds);
}

function refreshBody(refreshToken) {
  const body = new URLSearchParams();
  body.set('client_id', CODEX_CLIENT_ID);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  return body;
}

async function refreshAuth(auth, env = process.env, fetchImpl = fetch) {
  const tokens = auth && auth.tokens;
  if (!tokens || typeof tokens.refresh_token !== 'string') return null;
  const endpoint = env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || REFRESH_ENDPOINT;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshBody(tokens.refresh_token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`refresh endpoint returned ${response.status}`);
  const data = await response.json();
  if (typeof data.access_token !== 'string') throw new Error('refresh response has no access_token');
  return {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...tokens,
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : tokens.refresh_token,
      id_token: typeof data.id_token === 'string' ? data.id_token : tokens.id_token,
      account_id: typeof data.account_id === 'string' ? data.account_id : tokens.account_id,
    },
  };
}

function normalizePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function remainingFromUsed(used) {
  const normalized = normalizePercent(used);
  return normalized === null ? null : Math.max(0, Math.round(100 - normalized));
}

function findFiveHourWindow(windows) {
  return windows.find((window) => window.limit_window_seconds === FIVE_HOURS_SECONDS) || {};
}

function findTotalWindow(windows) {
  return windows
    .filter((window) => window.limit_window_seconds !== FIVE_HOURS_SECONDS)
    .sort((a, b) => (b.limit_window_seconds || 0) - (a.limit_window_seconds || 0))[0] || {};
}

async function fetchUsage(account, env = process.env, fetchImpl = fetch) {
  if (!hasAccessFields(account)) {
    return { id: account.id, state: STATES.OFFLINE, error: 'missing access_token or account_id' };
  }
  const endpoint = env.CODEX_USAGE_ENDPOINT || USAGE_ENDPOINT;
  const tokens = account.auth.tokens;
  try {
    const response = await fetchImpl(endpoint, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'ChatGPT-Account-Id': tokens.account_id,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        id: account.id,
        state: response.status === 401 || response.status === 403 ? STATES.OFFLINE : STATES.UNKNOWN,
        error: `usage endpoint returned ${response.status}`,
      };
    }
    const data = await response.json();
    const rateLimit = data.rate_limit || {};
    const windows = [rateLimit.primary_window, rateLimit.secondary_window].filter(Boolean);
    const next = findFiveHourWindow(windows);
    const total = findTotalWindow(windows);
    const nextUsed = normalizePercent(next.used_percent);
    const totalUsed = normalizePercent(total.used_percent);
    const usage = {
      id: account.id,
      plan: data.plan_type || '',
      nextUsed,
      nextRemaining: remainingFromUsed(nextUsed),
      nextReset: typeof next.reset_at === 'number' ? next.reset_at : null,
      nextSeconds: typeof next.limit_window_seconds === 'number' ? next.limit_window_seconds : null,
      totalUsed,
      totalRemaining: remainingFromUsed(totalUsed),
      totalReset: typeof total.reset_at === 'number' ? total.reset_at : null,
      totalSeconds: typeof total.limit_window_seconds === 'number' ? total.limit_window_seconds : null,
    };
    usage.state = classifyUsage(usage);
    return usage;
  } catch (error) {
    return {
      id: account.id,
      state: STATES.UNKNOWN,
      error: error && error.message ? error.message : String(error),
    };
  }
}


async function fetchUsageForList(account, busyByAccount, env = process.env) {
  const busy = busyByAccount.get(account.id.toLowerCase());
  if (busy && accessTokenExpiresWithin(account.auth, 60)) {
    return {
      id: account.id,
      state: STATES.IN_USE,
      error: ('active codex session ' + sessionSummary(busy)).trim(),
    };
  }
  const usage = await fetchUsage(account, env);
  if (!busy) return usage;
  return {
    ...usage,
    state: STATES.IN_USE,
    error: usage.error || ('active codex session ' + sessionSummary(busy)).trim(),
  };
}

async function fetchUsagesForList(accounts, env = process.env) {
  const busyByAccount = sessionsByAccount(env);
  return Promise.all(accounts.map((account) => fetchUsageForList(account, busyByAccount, env)));
}

function classifyWindowRemaining(remaining) {
  if (typeof remaining !== 'number') return STATES.COOLING;
  if (remaining <= 0) return STATES.COOLING;
  if (remaining <= LIMITED_REMAINING_PERCENT) return STATES.LIMITED;
  return STATES.AVAILABLE;
}

function classifyUsage(item) {
  if (!item || item.error) return item && item.state ? item.state : STATES.UNKNOWN;
  if (item.plan === 'free') return classifyWindowRemaining(item.totalRemaining);
  if (typeof item.totalRemaining !== 'number' || item.totalRemaining <= 0) return STATES.COOLING;
  if (typeof item.nextRemaining !== 'number') return classifyWindowRemaining(item.totalRemaining);
  return classifyWindowRemaining(item.nextRemaining);
}

async function refreshAccountsIfNeeded(accounts, env = process.env, output = process.stderr, options = {}) {
  let changed = false;
  const active = activeLabel(env);
  const skipBusy = options.skipBusy !== false;
  const busyByAccount = skipBusy ? sessionsByAccount(env) : new Map();
  const refreshed = [];
  for (const account of accounts) {
    if (busyByAccount.has(account.id.toLowerCase())) {
      refreshed.push(account);
      continue;
    }
    if (!tokenExpiresSoon(account.auth)) {
      refreshed.push(account);
      continue;
    }
    try {
      const nextAuth = await refreshAuth(account.auth, env);
      if (!nextAuth) {
        refreshed.push(account);
        continue;
      }
      const next = normalizeAccount(nextAuth, account.source || 'refresh');
      refreshed.push(next);
      changed = true;
      if (active && account.id.toLowerCase() === active.toLowerCase()) {
        writeFileAtomic(getAuthPath(env), `${JSON.stringify(nextAuth, null, 2)}\n`);
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      output.write(`refresh failed for ${displayAccount(account)}: ${message}\n`);
      refreshed.push(account);
    }
  }
  if (changed) writeSafeStore(refreshed, env);
  return refreshed;
}

function findCodexBin(env = process.env) {
  if (env.CODEX_BIN && isExecutable(env.CODEX_BIN)) return env.CODEX_BIN;
  const names = process.platform === 'win32' ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return '';
}

function isExecutable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return false;
  if (process.platform === 'win32') return fs.statSync(filePath).isFile();
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function runCodex(codexBin, args, env = process.env) {
  return new Promise((resolve) => {
    let child;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin)) {
      const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
      child = spawn(comspec, ['/d', '/s', '/c', `"${codexBin}" ${args.map((arg) => `"${String(arg).replace(/"/g, '\"')}"`).join(' ')}`], {
        stdio: 'inherit',
        env,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(codexBin, args, { stdio: 'inherit', env });
    }
    child.on('error', (error) => resolve({ error }));
    child.on('exit', (status, signal) => resolve({ status, signal }));
  });
}

function runCodexLogin(codexBin, tempHome, env = process.env) {
  const childEnv = { ...env, CODEX_HOME: tempHome };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(codexBin)) {
    const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
    return spawnSync(comspec, ['/d', '/s', '/c', `"${codexBin}" login`], {
      stdio: 'inherit',
      env: childEnv,
      windowsVerbatimArguments: true,
    });
  }
  return spawnSync(codexBin, ['login'], { stdio: 'inherit', env: childEnv });
}

function color(value, code, env = process.env, stream = process.stdout) {
  if (env.NO_COLOR || !stream.isTTY) return value;
  return `\u001b[${code}m${value}\u001b[0m`;
}

function green(value, env, stream) {
  return color(value, 32, env, stream);
}

function yellow(value, env, stream) {
  return color(value, 33, env, stream);
}

function red(value, env, stream) {
  return color(value, 31, env, stream);
}


function formatPlan(plan) {
  const names = {
    free: 'Free',
    plus: 'Plus',
    prolite: 'ProLite',
    pro: 'Pro',
    team: 'Team',
    business: 'Biz',
    enterprise: 'Ent',
    edu: 'Edu',
  };
  return names[plan] || plan || '-';
}

function formatRemaining(value) {
  return typeof value === 'number' ? `${value}%` : '-';
}

function displayTimeZone(env = process.env) {
  return env.CODEXM_TIME_ZONE || DEFAULT_TIME_ZONE;
}

function datePartsInTimeZone(epochSeconds, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch (_) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: DEFAULT_TIME_ZONE,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  const parts = {};
  for (const part of formatter.formatToParts(new Date(epochSeconds * 1000))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    month: parts.month || '--',
    day: parts.day || '--',
    hour: parts.hour || '--',
    minute: parts.minute || '--',
  };
}

function formatReset(value, mode = 'full', env = process.env) {
  if (typeof value !== 'number') return '';
  const now = Math.floor(Date.now() / 1000);
  if (value <= now) return 'reset';
  const { month, day, hour, minute } = datePartsInTimeZone(value, displayTimeZone(env));
  if (mode === 'time') return `${hour}:${minute}`;
  return `${month}-${day} ${hour}:${minute}`;
}

function stateLabel(state) {
  return state === STATES.AVAILABLE ? '' : (state || STATES.UNKNOWN);
}

function stateDisplay(state, env, stream) {
  const label = stateLabel(state);
  if (!label) return '';
  if (state === STATES.LIMITED || state === STATES.IN_USE) return yellow(label, env, stream);
  if (state === STATES.COOLING || state === STATES.OFFLINE) return red(label, env, stream);
  return label;
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function outputUsageTable(accounts, usages, env = process.env, output = process.stdout) {
  const active = activeLabel(env).toLowerCase();
  const rows = accounts.map((account, index) => {
    const usage = usages.find((item) => item.id === account.id) || {};
    const isCurrent = Boolean(active && account.id.toLowerCase() === active);
    return {
      index: `${index + 1}${isCurrent ? '*' : ''}`,
      account: displayAccount(account),
      plan: formatPlan(usage.plan),
      nextRemaining: formatRemaining(usage.nextRemaining),
      nextReset: formatReset(usage.nextReset, 'time', env) || '-',
      totalRemaining: formatRemaining(usage.totalRemaining),
      totalReset: formatReset(usage.totalReset, 'full', env) || '-',
      state: usage.state || STATES.UNKNOWN,
      stateLabel: stateLabel(usage.state || STATES.UNKNOWN),
      isCurrent,
      error: usage.error || '',
    };
  });
  const showState = rows.some((row) => row.stateLabel);
  const widths = {
    index: Math.max(3, ...rows.map((row) => row.index.length)),
    account: Math.max(7, ...rows.map((row) => row.account.length)),
    plan: Math.max(4, ...rows.map((row) => row.plan.length)),
    nextRemaining: Math.max('5h'.length, ...rows.map((row) => row.nextRemaining.length)),
    nextReset: Math.max('Reset'.length, ...rows.map((row) => row.nextReset.length)),
    totalRemaining: Math.max('Total'.length, ...rows.map((row) => row.totalRemaining.length)),
    totalReset: Math.max('Reset'.length, ...rows.map((row) => row.totalReset.length)),
    state: showState ? Math.max('Status'.length, ...rows.map((row) => row.stateLabel.length)) : 0,
  };
  const gap = '  ';
  const header = [
    pad('No.', widths.index),
    pad('Account', widths.account),
    pad('Plan', widths.plan),
    pad('5h', widths.nextRemaining),
    pad('Reset', widths.nextReset),
    pad('Total', widths.totalRemaining),
    pad('Reset', widths.totalReset),
  ];
  if (showState) header.push('Status');
  output.write(`${header.join(gap)}\n`);
  for (const row of rows) {
    const columns = [
      pad(row.index, widths.index),
      pad(row.account, widths.account),
      pad(row.plan, widths.plan),
      pad(row.nextRemaining, widths.nextRemaining),
      pad(row.nextReset, widths.nextReset),
      pad(row.totalRemaining, widths.totalRemaining),
      pad(row.totalReset, widths.totalReset),
    ];
    if (showState) columns.push(pad(stateDisplay(row.state, env, output), widths.state));
    output.write(`${columns.join(gap)}\n`);
  }
}

function outputAccountTable(accounts, env = process.env, output = process.stdout) {
  const active = activeLabel(env).toLowerCase();
  const rows = accounts.map((account, index) => {
    const isCurrent = Boolean(active && account.id.toLowerCase() === active);
    return {
      index: `${index + 1}${isCurrent ? '*' : ''}`,
      account: displayAccount(account),
      source: account.source || '-',
      isCurrent,
    };
  });
  const widths = {
    index: Math.max(3, ...rows.map((row) => row.index.length)),
    account: Math.max(7, ...rows.map((row) => row.account.length)),
  };
  output.write(`${pad('No.', widths.index)} ${pad('Account', widths.account)} Source\n`);
  for (const row of rows) {
    const line = `${pad(row.index, widths.index)} ${pad(row.account, widths.account)} ${row.source}`;
    output.write(`${line}\n`);
  }
}

function usageJson(accounts, usages, env = process.env) {
  const active = activeLabel(env).toLowerCase();
  return accounts.map((account) => {
    const usage = usages.find((item) => item.id === account.id) || {};
    return {
      id: account.id,
      label: displayAccount(account),
      email: account.email || '',
      shortId: account.shortId || '',
      current: Boolean(active && account.id.toLowerCase() === active),
      source: account.source || '',
      plan: usage.plan || '',
      state: usage.state || STATES.UNKNOWN,
      nextRemaining: usage.nextRemaining ?? null,
      nextReset: usage.nextReset ?? null,
      nextSeconds: usage.nextSeconds ?? null,
      totalRemaining: usage.totalRemaining ?? null,
      totalReset: usage.totalReset ?? null,
      totalSeconds: usage.totalSeconds ?? null,
      error: usage.error || '',
    };
  });
}

async function cmdInit(env, output) {
  const auth = readActiveAuth(env);
  if (!auth) throw new Error(`active auth not found: ${getAuthPath(env)}`);
  const { account, overwritten } = upsertAccount(auth, env, 'init');
  output.write(`${overwritten ? 'updated' : 'added'} ${displayAccount(account)} in ${getSafeStorePath(env)}\n`);
}

async function cmdImportCodexs(env, output) {
  const sourcePath = getCodexsStorePath(env);
  const source = readJsonFile(sourcePath, null);
  if (!source) throw new Error(`codexs store not found: ${sourcePath}`);
  if (!source || source.version !== 1 || !Array.isArray(source.accounts)) {
    throw new Error(`invalid codexs store format: ${sourcePath}`);
  }
  const current = readSafeStore(env);
  let imported = 0;
  let updated = 0;
  const next = [...current];
  for (const auth of source.accounts) {
    const account = normalizeAccount(auth, 'codexs-import');
    const before = next.length;
    const filtered = next.filter((item) => item.id.toLowerCase() !== account.id.toLowerCase());
    if (filtered.length === before) imported += 1;
    else updated += 1;
    next.length = 0;
    next.push(...filtered, account);
  }
  writeSafeStore(next, env);
  output.write(`imported ${imported}, updated ${updated}; store: ${getSafeStorePath(env)}\n`);
}
async function cmdSyncCodexs(env, output) {
  const sourcePath = getCodexsStorePath(env);
  const source = readJsonFile(sourcePath, null);
  if (!source) throw new Error(`codexs store not found: ${sourcePath}`);
  if (!source || source.version !== 1 || !Array.isArray(source.accounts)) {
    throw new Error(`invalid codexs store format: ${sourcePath}`);
  }
  const before = readSafeStore(env).length;
  const accounts = source.accounts.map((auth) => normalizeAccount(auth.auth || auth, 'codexs-sync'));
  writeSafeStore(accounts, env);
  output.write(`synced ${accounts.length} account(s) from codexs; replaced previous ${before} account(s); store: ${getSafeStorePath(env)}\n`);
}

async function cmdAdd(env, output) {
  const codexBin = findCodexBin(env);
  if (!codexBin) throw new Error('codex executable not found; set CODEX_BIN or add codex to PATH');
  const root = getCodexHome(env);
  ensureDir(root);
  const tempHome = fs.mkdtempSync(path.join(root, '.codexm-login.'));
  let keepTemp = false;
  try {
    const result = runCodexLogin(codexBin, tempHome, env);
    if (result.status !== 0) {
      throw new Error(`codex login failed with exit code ${result.status ?? 'unknown'}`);
    }
    const auth = readAuthFromPath(path.join(tempHome, AUTH_FILE_NAME));
    if (!auth) {
      keepTemp = true;
      throw new Error(`login finished but no auth was found; temp home kept at ${tempHome}`);
    }
    const { account, overwritten } = upsertAccount(auth, env, 'add');
    fs.rmSync(tempHome, { recursive: true, force: true });
    output.write(`${overwritten ? 'updated' : 'added'} ${displayAccount(account)}\n`);
  } catch (error) {
    if (!keepTemp) {
      try {
        fs.rmSync(tempHome, { recursive: true, force: true });
      } catch (_) {}
    }
    throw error;
  }
}

async function cmdList(args, env, output) {
  const json = args.includes('--json');
  const noUsage = args.includes('--no-usage');
  const noRefresh = args.includes('--no-refresh');
  let accounts = readSafeStore(env);
  syncActiveAuthFromStore(accounts, env);
  if (!noRefresh) accounts = await refreshAccountsIfNeeded(accounts, env, output);
  syncActiveAuthFromStore(accounts, env);
  if (noUsage) {
    if (json) output.write(`${JSON.stringify(usageJson(accounts, [], env), null, 2)}\n`);
    else outputAccountTable(accounts, env, output);
    return;
  }
  const usages = await fetchUsagesForList(accounts, env);
  if (json) output.write(`${JSON.stringify(usageJson(accounts, usages, env), null, 2)}\n`);
  else outputUsageTable(accounts, usages, env, output);
}

async function cmdUse(args, env, output) {
  let accounts = readSafeStore(env);
  syncActiveAuthFromStore(accounts, env);
  if (args.length > 1) throw new Error('usage: codexm use [account]');
  if (args.length === 0) {
    accounts = await refreshAccountsIfNeeded(accounts, env, output);
    syncActiveAuthFromStore(accounts, env);
    const usages = await fetchUsagesForList(accounts, env);
    const active = activeLabel(env).toLowerCase();
    const current = accounts.find((account) => active && account.id.toLowerCase() === active);
    const currentUsage = current ? usages.find((item) => item.id === current.id) : null;
    if (current && currentUsage && currentUsage.state === STATES.AVAILABLE) {
      output.write(`current account is available: ${displayAccount(current)}\n`);
      return;
    }
    const next = accounts.find((account) => {
      const item = usages.find((usage) => usage.id === account.id);
      return item && item.state === STATES.AVAILABLE && (!active || account.id.toLowerCase() !== active);
    });
    if (!next) throw new Error('no available account found');
    await activateAccount(next, env, output);
    return;
  }
  const account = resolveAccount(args[0], accounts);
  if (!account) throw new Error(`account not found: ${args[0]}`);
  await activateAccount(account, env, output);
}

async function activateAccount(account, env, output) {
  rememberActiveAuthIfMissing(env, 'pre-switch-backup');
  writeFileAtomic(getAuthPath(env), `${JSON.stringify(account.auth, null, 2)}\n`);
  output.write(`activated ${displayAccount(account)} at ${getAuthPath(env)}\n`);
}

async function cmdRefresh(args, env, output) {
  const force = args.includes('--force');
  const positional = args.filter((arg) => arg !== '--force');
  const selector = positional[0] || 'all';
  if (positional.length > 1) throw new Error('usage: codexm refresh [all|account] [--force]');
  const accounts = readSafeStore(env);
  syncActiveAuthFromStore(accounts, env);
  const targets = selector === 'all'
    ? accounts
    : [resolveAccount(selector, accounts)].filter(Boolean);
  if (targets.length === 0) throw new Error(`account not found: ${selector}`);
  const byId = new Map(accounts.map((account) => [account.id.toLowerCase(), account]));
  const busyByAccount = sessionsByAccount(env);
  for (const account of targets) {
    const busy = busyByAccount.get(account.id.toLowerCase());
    if (busy && !force) {
      output.write(`skipped ${displayAccount(account)}: active codex session ${sessionSummary(busy)}; use --force to refresh anyway\n`);
      continue;
    }
    const nextAuth = await refreshAuth(account.auth, env);
    if (!nextAuth) {
      output.write(`skipped ${displayAccount(account)}: no refresh_token\n`);
      continue;
    }
    byId.set(account.id.toLowerCase(), normalizeAccount(nextAuth, 'refresh'));
    output.write(`refreshed ${displayAccount(account)}\n`);
  }
  const nextAccounts = [...byId.values()];
  writeSafeStore(nextAccounts, env);
  syncActiveAuthFromStore(nextAccounts, env);
}

async function cmdRun(args, env, output) {
  const codexBin = env.CODEXM_REAL_CODEX_BIN || findCodexBin(env);
  if (!codexBin) throw new Error('codex executable not found; set CODEXM_REAL_CODEX_BIN, CODEX_BIN, or add codex to PATH');
  const accounts = readSafeStore(env);
  syncActiveAuthFromStore(accounts, env);
  let beforeAuth = null;
  try {
    beforeAuth = readActiveAuth(env);
  } catch (_) {
    beforeAuth = null;
  }
  let lease = null;
  let heartbeat = null;
  try {
    const runAccount = beforeAuth ? normalizeAccount(beforeAuth, 'codex-run') : null;
    if (runAccount) {
      lease = createSessionLease(runAccount, env, output);
      heartbeat = setInterval(() => lease.touch(), sessionHeartbeatMs(env));
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    output.write(`warning: failed to create codexm session lease: ${message}\n`);
  }
  let result;
  try {
    result = await runCodex(codexBin, args, env);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (lease) lease.release();
    try {
      upsertActiveAuthIfChanged(beforeAuth, env, 'codex-run');
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      output.write(`warning: failed to sync active auth after codex: ${message}\n`);
    }
  }
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) process.exitCode = result.status;
}

async function cmdRemove(args, env, output, input) {
  const yes = args.includes('--yes');
  const selector = args.find((arg) => arg !== '--yes');
  if (!selector) {
    await cmdRemoveOffline(env, output, input, yes);
    return;
  }
  const accounts = readSafeStore(env);
  const account = resolveAccount(selector, accounts);
  if (!account) throw new Error(`account not found: ${selector}`);
  if (!yes) {
    if (!input.isTTY) throw new Error('remove requires --yes in non-interactive mode');
    const rl = readline.createInterface({ input, output });
    const answer = await rl.question(`Remove ${displayAccount(account)} from codexm store? Type yes: `);
    rl.close();
    if (answer !== 'yes') {
      output.write('cancelled\n');
      return;
    }
  }
  writeSafeStore(accounts.filter((item) => item.id.toLowerCase() !== account.id.toLowerCase()), env);
  output.write(`removed ${displayAccount(account)}\n`);
}

async function cmdRemoveOffline(env, output, input, yes = false) {
  const accounts = await refreshAccountsIfNeeded(readSafeStore(env), env, output);
  if (accounts.length === 0) {
    output.write('no accounts in codexm store\n');
    return;
  }
  const usages = await fetchUsagesForList(accounts, env);
  const offlineIds = new Set(usages
    .filter((item) => item.state === STATES.OFFLINE)
    .map((item) => item.id.toLowerCase()));
  const offlineAccounts = accounts.filter((account) => offlineIds.has(account.id.toLowerCase()));
  if (offlineAccounts.length === 0) {
    output.write('no offline accounts found\n');
    return;
  }
  if (!yes && !input.isTTY) {
    throw new Error('interactive confirmation is required; rerun with remove --yes to delete all offline accounts');
  }

  const removeIds = new Set();
  let rl = null;
  try {
    if (!yes) rl = readline.createInterface({ input, output });
    for (const account of offlineAccounts) {
      if (yes) {
        removeIds.add(account.id.toLowerCase());
        continue;
      }
      const answer = await rl.question(`Remove offline account ${displayAccount(account)}? Type yes: `);
      if (answer === 'yes') removeIds.add(account.id.toLowerCase());
      else output.write(`kept ${displayAccount(account)}\n`);
    }
  } finally {
    if (rl) rl.close();
  }

  if (removeIds.size === 0) {
    output.write('nothing removed\n');
    return;
  }
  writeSafeStore(accounts.filter((account) => !removeIds.has(account.id.toLowerCase())), env);
  output.write(`removed ${removeIds.size} offline account(s)\n`);
}

async function cmdDoctor(env, output) {
  const authPath = getAuthPath(env);
  const safeStore = getSafeStorePath(env);
  const codexsStore = getCodexsStorePath(env);
  output.write(`Codex home:      ${getCodexHome(env)}\n`);
  output.write(`Active auth:     ${authPath} ${fs.existsSync(authPath) ? '(exists)' : '(missing)'}\n`);
  const sessionStore = getSessionStorePath(env);
  const sessions = readSessionStore(env);
  output.write(`codexm store:    ${safeStore} ${fs.existsSync(safeStore) ? '(exists)' : '(missing)'}\n`);
  output.write(`session store:   ${sessionStore} ${fs.existsSync(sessionStore) ? `(${sessions.length} active)` : '(missing)'}\n`);
  output.write(`codexs store:    ${codexsStore} ${fs.existsSync(codexsStore) ? '(exists)' : '(missing)'}\n`);
  output.write(`codex binary:    ${findCodexBin(env) || '(not found)'}\n`);
  output.write(`usage endpoint:  ${env.CODEX_USAGE_ENDPOINT || USAGE_ENDPOINT}\n`);
  output.write(`refresh endpoint:${env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || REFRESH_ENDPOINT}\n`);
  output.write(`display time zone:${displayTimeZone(env)}\n`);
}

function printHelp(output = process.stdout) {
  output.write(`codexm - local-only Codex account manager

Commands:
  codexm doctor
  codexm init | i
  codexm import-codexs
  codexm sync-codexs | sync
  codexm add | a
  codexm list | l [--json] [--no-usage] [--no-refresh]
  codexm use | u [account]
  codexm refresh [all|account] [--force]
  codexm run [codex args...]
  codexm remove | r [account] [--yes]
  codexm help

Defaults:
  list and use automatically refresh expiring access tokens before checking usage, except accounts currently in codexm run.
  remove without account probes usage and interactively removes offline accounts.
  run wraps the official codex CLI, marks the account in-use while running, and syncs auth after it exits.

Account selectors:
  1, 2, ...          list index
  user@example.com   email decoded from id_token
  abcd1234           first 8 chars of account_id

Files:
  active auth:        ${path.join('~', '.codex', AUTH_FILE_NAME)}
  codexm store:       ${path.join('~', '.codex', SAFE_STORE_NAME)}
  codexs import src:  ${path.join('~', '.codex', CODEXS_STORE_NAME)}

Network:
  usage:   ${USAGE_ENDPOINT}
  refresh: ${REFRESH_ENDPOINT}
`);
}

async function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env || process.env;
  const output = io.output || process.stdout;
  const input = io.input || process.stdin;
  const alias = {
    i: 'init',
    a: 'add',
    l: 'list',
    u: 'use',
    r: 'remove',
    '-h': 'help',
    '--help': 'help',
  };
  const command = alias[argv[0]] || argv[0] || 'help';
  const args = argv.slice(1);

  switch (command) {
    case 'doctor':
      await cmdDoctor(env, output);
      break;
    case 'init':
      await cmdInit(env, output);
      break;
    case 'import-codexs':
      await cmdImportCodexs(env, output);
      break;
    case 'sync-codexs':
    case 'sync':
      await cmdSyncCodexs(env, output);
      break;
    case 'add':
      await cmdAdd(env, output);
      break;
    case 'list':
      await cmdList(args, env, output);
      break;
    case 'use':
      await cmdUse(args, env, output);
      break;
    case 'refresh':
      await cmdRefresh(args, env, output);
      break;
    case 'run':
      await cmdRun(args, env, output);
      break;
    case 'remove':
      await cmdRemove(args, env, output, input);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp(output);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  normalizeAccount,
  classifyUsage,
  remainingFromUsed,
  formatReset,
  displayTimeZone,
  syncActiveAuthFromStore,
  upsertActiveAuthIfChanged,
  rememberActiveAuthIfMissing,
  getSessionStorePath,
  sessionsByAccount,
};






