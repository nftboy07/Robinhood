#!/usr/bin/env node
/**
 * setup.js - Create config.json from config.json.example with verified chain addresses.
 * Usage: node setup.js
 */
const fs = require('fs');
const path = require('path');

const EXAMPLE = path.join(__dirname, 'config.json.example');
const TARGET = path.join(__dirname, 'config.json');

if (fs.existsSync(TARGET)) {
  console.log('config.json already exists — not overwriting.');
  console.log('To reset: rm config.json && node setup.js');
  process.exit(0);
}

if (!fs.existsSync(EXAMPLE)) {
  console.error('Missing config.json.example');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
fs.writeFileSync(TARGET, JSON.stringify(config, null, 2) + '\n');

console.log('=== config.json created ===');
console.log('factory   :', config.factory, '(O1 Launchpad v3 — active)');
console.log('weth      :', config.weth, '(VIRTUAL wrapped native)');
console.log('router    :', config.router, '(Uniswap V4 router)');
console.log('dexFactory:', config.dexFactory);
console.log('\nNext: copy .env.example to .env, add PK + Telegram credentials, then run node vps_diag.js');
