const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Real discovered addresses on Robinhood Chain (4663)
config.factory    = '0xE7fC3eD1cCe4222047F07d4E58AF41C89Ac4A800'; // Launchpad factory (fun.noxa.fi)
config.weth       = '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31'; // VIRTUAL (wrapped native on Robin chain)
config.router     = '0x428575d8B9f23C778c9Df2eE1E2a875970D8135A'; // Main DEX router (confirmed from swap events)
config.dexFactory = '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f'; // Uniswap V2-style DEX factory (3020 pairs)

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log('=== config.json patched successfully ===');
console.log('factory   :', config.factory);
console.log('weth      :', config.weth);
console.log('router    :', config.router);
console.log('dexFactory:', config.dexFactory);
