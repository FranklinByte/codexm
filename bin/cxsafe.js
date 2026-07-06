#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const commands = require('../src/commands');
const { readAccounts, writeAccounts } = require('../src/accounts');
const { getAccountsFile, getCodexHome } = require('../src/paths');
const { findCodexBin } = require('../src/codex');

function usage(output = process.stdout) {
  output.write(`codexm - Codex account switcher, codexs-compatible local build

Commands:
  codexm init|i
  codexm add|a
  codexm list|l
  codexm use|u [account]
  codexm remove|r [account]
  codexm sync-codexs|sync
  codexm doctor
  codexm help

Notes:
  account can be a list number, email, or short account id.
  use without account auto-selects an available account, same as codexs.
  codexm stores accounts in ~/.codex/codexm-accounts.json using the codexs store shape.
  ~/.codex/auth.json is the active Codex slot.
  codexm never wraps the official codex command. After switching, run codex directly.
`);
}

function assertNoExtra(args, command) {
  if (args.length !== 0) throw new Error(`usage: codexm ${command}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function syncCodexs(env = process.env, output = process.stdout) {
  const sourcePath = path.join(getCodexHome(env), 'codex-accounts.json');
  if (!fs.existsSync(sourcePath)) throw new Error(`codexs store not found: ${sourcePath}`);
  const source = readJson(sourcePath);
  if (!source || source.version !== 1 || !Array.isArray(source.accounts)) {
    throw new Error(`invalid codexs store format: ${sourcePath}`);
  }
  const accounts = source.accounts.map((auth) => ({ auth }));
  const before = readAccounts(env).length;
  writeAccounts(accounts, env);
  output.write(`synced ${accounts.length} account(s) from codexs; replaced previous ${before}; store: ${getAccountsFile(env)}\n`);
}

function doctor(env = process.env, output = process.stdout) {
  const codexHome = getCodexHome(env);
  const authPath = path.join(codexHome, 'auth.json');
  const codexmStore = getAccountsFile(env);
  const codexsStore = path.join(codexHome, 'codex-accounts.json');
  const codexBin = findCodexBin(env);
  output.write(`Codex home:   ${codexHome}\n`);
  output.write(`Active auth:  ${authPath} (${fs.existsSync(authPath) ? 'exists' : 'missing'})\n`);
  output.write(`codexm store: ${codexmStore} (${fs.existsSync(codexmStore) ? 'exists' : 'missing'})\n`);
  output.write(`codexs store: ${codexsStore} (${fs.existsSync(codexsStore) ? 'exists' : 'missing'})\n`);
  output.write(`codex binary: ${codexBin || '(not found)'}\n`);
}

async function main(argv = process.argv.slice(2), io = {}) {
  const output = io.output || process.stdout;
  const input = io.input || process.stdin;
  const errOutput = io.errOutput || process.stderr;
  const env = io.env || process.env;
  const ALIAS = {
    i: 'init',
    l: 'list',
    a: 'add',
    u: 'use',
    r: 'remove',
    sync: 'sync-codexs',
    '-h': 'help',
    '--help': 'help',
  };
  const [raw = 'help', ...args] = argv;
  const command = ALIAS[raw] || raw;

  switch (command) {
    case 'init':
      assertNoExtra(args, 'init');
      commands.initAccounts(env, output);
      break;
    case 'list':
      assertNoExtra(args, 'list');
      await commands.listAccounts(env, output);
      break;
    case 'add':
      assertNoExtra(args, 'add');
      await commands.addAccount(env, output);
      break;
    case 'use':
      if (args.length === 0) await commands.useDefaultAccount(env, output);
      else if (args.length === 1) commands.useAccount(args[0], env, output);
      else throw new Error('usage: codexm use [account]');
      break;
    case 'remove':
      if (args.length === 0) await commands.removeOfflineAccounts(env, output, input, errOutput);
      else if (args.length === 1) commands.removeAccount(args[0], env, output);
      else throw new Error('usage: codexm remove [account]');
      break;
    case 'sync-codexs':
      assertNoExtra(args, 'sync-codexs');
      syncCodexs(env, output);
      break;
    case 'doctor':
      assertNoExtra(args, 'doctor');
      doctor(env, output);
      break;
    case 'run':
      throw new Error('codexm run was removed; use codexm use to switch accounts, then run the official codex command directly');
    case 'help':
      usage(output);
      break;
    default:
      errOutput.write(`unknown command: ${raw}\n`);
      usage(errOutput);
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`error: ${message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  syncCodexs,
  doctor,
};