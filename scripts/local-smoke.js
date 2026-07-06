'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cli = require('../bin/cxsafe.js');
const commands = require('../src/commands');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexm-local-'));
const home = path.join(tmp, 'codex-home');
fs.mkdirSync(home, { recursive: true });
const fakeCodex = path.join(tmp, process.platform === 'win32' ? 'codex.cmd' : 'codex');
fs.writeFileSync(fakeCodex, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
try { fs.chmodSync(fakeCodex, 0o755); } catch (_) {}

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function jwt(payload) { return [b64({ alg: 'none' }), b64(payload), 'sig'].join('.'); }
function auth(email, accountId) {
  return { tokens: { id_token: jwt({ email }), access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: `refresh-${email}`, account_id: accountId } };
}
function output() { return { text: '', write(value) { this.text += value; } }; }
async function run(args, env) { const out = output(); await cli.main(args, { env, output: out, errOutput: out }); return out.text; }

(async () => {
  const env = { ...process.env, CODEX_HOME: home, CODEX_BIN: fakeCodex };
  const one = auth('one@example.com', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const two = auth('two@example.com', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  const storePath = path.join(home, 'codexm-accounts.json');
  fs.writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{ auth: one }, { auth: two }] }, null, 2));
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(one, null, 2));

  await run(['use', '2'], env);
  const active = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
  if (!active.tokens.refresh_token.includes('two@example.com')) throw new Error('use did not activate account 2');

  await run(['init'], env);
  const written = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  if (!Array.isArray(written.accounts) || written.accounts.some((item) => item.auth)) throw new Error('store was not written in codexs auth-array shape');

  const beforeList = fs.readFileSync(storePath, 'utf8');
  const listOut = output();
  await commands.listAccounts(env, listOut, {
    refreshFetch: async () => { throw new Error('list unexpectedly called refresh'); },
    usageFetch: async () => ({
      ok: true,
      json: async () => ({
        plan_type: 'Team',
        rate_limit: {
          primary_window: { limit_window_seconds: 18000, used_percent: 12, reset_at: Math.floor(Date.now() / 1000) + 1800 },
          secondary_window: { limit_window_seconds: 604800, used_percent: 34, reset_at: Math.floor(Date.now() / 1000) + 86400 },
        },
      }),
    }),
  });
  const afterList = fs.readFileSync(storePath, 'utf8');
  if (afterList !== beforeList) throw new Error('list modified account store');

  await run(['remove', '1'], env);
  const afterRemove = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  if (afterRemove.accounts.length !== 1) throw new Error('remove did not remove one account');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('local smoke ok');
})().catch((error) => { console.error(error); process.exitCode = 1; });