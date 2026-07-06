'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'bin', 'cxsafe.js')]
  .concat(fs.readdirSync(path.join(root, 'src'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(root, 'src', name)));

let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;