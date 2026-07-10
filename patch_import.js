// patch_import.js — Add token auto-import from Blockscout to robinhood_bot.js
const fs = require('fs');

let src = fs.readFileSync('./robinhood_bot.js', 'utf8');

// =====================================================================
// 1. Insert importTokensFromBlockscout function above handlePositions
// =====================================================================
const targetText = 'async function handlePositions(chatId) {';
const importFunc = `async function importTokensFromBlockscout(chatId) {
  try {
    await sendTg('⏳ Checking Blockscout for on-chain token balances to import...');
    
    const url = \`https://robinhoodchain.blockscout.com/api/v2/addresses/\${wallet.address}/token-balances\`;
    
    const https = require('https');
    const rawData = await new Promise((resolve, reject) => {
      https.get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });

    const items = JSON.parse(rawData);
    if (!Array.isArray(items)) {
      await sendTg('❌ Failed to parse token balances from Blockscout.');
      return;
    }

    let importedCount = 0;
    const importedSymbols = [];

    for (const item of items) {
      if (!item.token || item.token.type !== 'ERC-20') continue;
      const tokenAddr = item.token.address_hash.toLowerCase();
      const value = item.value || '0';
      const bal = BigInt(value);
      if (bal === 0n) continue;

      // Skip native wrapped tokens
      if (WETH && tokenAddr === WETH.toLowerCase()) continue;

      // Check if already in positions
      const exists = positions.some(p => (p.token || p.curve).toLowerCase() === tokenAddr);
      if (exists) continue;

      const name = item.token.name || 'Unknown';
      const symbol = item.token.symbol || '???';
      const sym = \`\${name} (\${symbol})\`;

      // Get current price if possible
      const price = await getLivePrice(tokenAddr, tokenAddr).catch(() => 0n);

      positions.push({
        curve: tokenAddr,
        token: tokenAddr,
        symbol: sym,
        amount: bal,
        entryPrice: price, // set to current price to track gains from import point
        highestPrice: price,
        isMigrated: true, // assume DEX fallback is safest for old holdings
        entryBlock: 0,
        soldAmount: 0n,
        reEntries: 0,
        tpReached: []
      });

      importedCount++;
      importedSymbols.push(symbol);
    }

    if (importedCount > 0) {
      savePositions();
      await sendTg(\`✅ Imported \${importedCount} token(s) from your wallet: \${importedSymbols.join(', ')}\\n\\nThey are now tracked in your positions list!\`);
    }
  } catch (e) {
    logger.warn('Failed to import tokens from Blockscout: ' + e.message);
  }
}

`;

if (src.includes(targetText)) {
  src = src.replace(targetText, importFunc + targetText);
  console.log('✓ Patch 1: importTokensFromBlockscout inserted');
} else {
  console.error('Could not find handlePositions definition target!');
  process.exit(1);
}

// =====================================================================
// 2. Add /import text command to Telegram text command handler
// =====================================================================
const textCommandOld = `      } else if (text === '/refresh' || text === '/fixpos') {`;
const textCommandNew = `      } else if (text === '/import') {
        await importTokensFromBlockscout(msg.chat.id);
      } else if (text === '/refresh' || text === '/fixpos') {
        await importTokensFromBlockscout(msg.chat.id).catch(() => {});`;

if (src.includes(textCommandOld)) {
  src = src.replace(textCommandOld, textCommandNew);
  console.log('✓ Patch 2: /import command and auto-import on text /refresh added');
} else {
  console.warn('Patch 2 target not found with CRLF. Trying LF version.');
  const textCommandOldLF = textCommandOld.replace(/\r\n/g, '\n');
  const textCommandNewLF = textCommandNew.replace(/\r\n/g, '\n');
  if (src.includes(textCommandOldLF)) {
    src = src.replace(textCommandOldLF, textCommandNewLF);
    console.log('✓ Patch 2: /import command and auto-import on text /refresh added (LF)');
  }
}

// =====================================================================
// 3. Add auto-import to callback 'refresh' query handler
// =====================================================================
const callbackOld = `      } else if (data === 'refresh' || data === 'fixpos') {`;
const callbackNew = `      } else if (data === 'refresh' || data === 'fixpos') {
        await importTokensFromBlockscout(chatId).catch(() => {});`;

if (src.includes(callbackOld)) {
  src = src.replace(callbackOld, callbackNew);
  console.log('✓ Patch 3: auto-import on button refresh added');
} else {
  console.warn('Patch 3 target not found with CRLF. Trying LF version.');
  const callbackOldLF = callbackOld.replace(/\r\n/g, '\n');
  const callbackNewLF = callbackNew.replace(/\r\n/g, '\n');
  if (src.includes(callbackOldLF)) {
    src = src.replace(callbackOldLF, callbackNewLF);
    console.log('✓ Patch 3: auto-import on button refresh added (LF)');
  }
}

fs.writeFileSync('./robinhood_bot.js', src);
console.log('Done - patch_import.js completed successfully.');
