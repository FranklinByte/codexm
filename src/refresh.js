const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REFRESH_GRACE_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 8000;

const decodeJwtPayload = (token) => {
  if (typeof token !== 'string') return null;
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
};

const tokenExpiresSoon = (auth, nowSeconds = Math.floor(Date.now() / 1000)) => {
  const payload = decodeJwtPayload(auth && auth.tokens && auth.tokens.access_token);
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp - nowSeconds <= REFRESH_GRACE_SECONDS;
};

const buildRefreshBody = (refreshToken) => {
  const body = new URLSearchParams();
  body.set('client_id', CLIENT_ID);
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', refreshToken);
  return body;
};

const refreshAuth = async (auth, env = process.env, fetchImpl = fetch) => {
  const tokens = auth && auth.tokens;
  if (!tokens || typeof tokens.refresh_token !== 'string') return null;
  if (typeof fetchImpl !== 'function' || typeof AbortSignal.timeout !== 'function') return null;

  const response = await fetchImpl(env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || DEFAULT_REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildRefreshBody(tokens.refresh_token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`刷新接口返回 ${response.status}`);

  const data = await response.json();
  if (typeof data.access_token !== 'string') throw new Error('刷新响应缺少 access_token');
  const nextTokens = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : tokens.refresh_token,
  };
  if (typeof data.id_token === 'string') nextTokens.id_token = data.id_token;
  if (typeof data.account_id === 'string') nextTokens.account_id = data.account_id;

  return { ...auth, last_refresh: new Date().toISOString(), tokens: nextTokens };
};

module.exports = {
  refreshAuth,
  tokenExpiresSoon,
};
