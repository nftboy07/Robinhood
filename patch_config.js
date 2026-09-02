const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json not found. Run: node setup.js');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Verified addresses on Robinhood Chain (4663) — updated Sep 2026
config.factory    = '0x411F21283D3E492BC395027329e08f9F4F560Ba5'; // O1 Launchpad v3 (active — 15+ launches in 50k blocks)
config.weth       = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31'; // VIRTUAL (wrapped native on Robin chain)
config.router     = '0x8876789976dEcBfCbBbe364623C63652db8C0904'; // Uniswap V4 router (confirmed from swap events)
config.dexFactory = '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f'; // Uniswap V2-style DEX factory
config.debankChainId = config.debankChainId || 'hood';

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
console.log('=== config.json patched successfully ===');
console.log('factory   :', config.factory);
console.log('weth      :', config.weth);
console.log('router    :', config.router);
console.log('dexFactory:', config.dexFactory);
