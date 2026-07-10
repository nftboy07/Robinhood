// patch_launch.js — patches the launch detection loop in robinhood_bot.js
const fs = require('fs');

const file = './robinhood_bot.js';
let src = fs.readFileSync(file, 'utf8');

const OLD = `    for (const log of logs) {\r\n      if (isPaused) break;\r\n      try {\r\n        // Standard: topics[1] = token (ERC20 for balance/name), topics[2] = curve (for buy/sell/getPrice)\r\n        const tokenAddr = '0x' + log.topics[1].slice(-40);\r\n        let curveAddr = tokenAddr;\r\n        if (log.topics.length > 2 && log.topics[2] && log.topics[2] !== '0x0000000000000000000000000000000000000000000000000000000000000000') {\r\n          curveAddr = '0x' + log.topics[2].slice(-40);\r\n        }\r\n        logger.info(\`[NEW LAUNCH] curve: \${curveAddr} (token: \${tokenAddr}) on fun.noxa.fi/robinhood\`);\r\n        curveToToken.set(curveAddr.toLowerCase(), tokenAddr.toLowerCase());\r\n        db.logLaunch(curveAddr, tokenAddr, DisplayName = "NEW");\r\n        // Fire-and-forget alerts / menus so one slow TG doesn't block poll loop\r\n        sendAlert(\`🚀 New launch: \${curveAddr} on fun.noxa.fi/robinhood\`).catch(()=>{});\r\n        sendTg(\`🚀 New launch detected: <code>\${curveAddr}</code>\`).catch(()=>{});\r\n        sendBuyMenu(curveAddr, "NEW", tokenAddr).catch(()=>{});\r\n        // Get info + recent (non blocking for main poll)\r\n        getTokenInfo(tokenAddr).then(info => {\r\n          let display = \`\${info.name} (\${info.symbol})\`;\r\n          if (info.name === "Unknown Token") {\r\n            const short = tokenAddr.slice(0,6) + "..." + tokenAddr.slice(-4);\r\n            display = \`Unnamed (\${short})\`;\r\n          }\r\n          recentLaunches.unshift({addr: curveAddr, symbol: display, time: Date.now()});\r\n          if (recentLaunches.length > 5) recentLaunches.pop();\r\n        }).catch(()=>{});\r\n        // Auto snipe uses curveAddr (buy target) - delayed\r\n        setTimeout(() => snipe(curveAddr, null, tokenAddr), 1500);\r\n      } catch (logErr) {\r\n        try {\r\n          const addr = '0x' + log.topics[1].slice(-40);\r\n          sendBuyMenu(addr, 'LAUNCH', addr).catch(()=>{});\r\n          recentLaunches.unshift({addr: addr, symbol: 'LAUNCH', time: Date.now()});\r\n          if (recentLaunches.length > 5) recentLaunches.pop();\r\n          setTimeout(() => snipe(addr, 'LAUNCH'), 1800);\r\n        } catch {}\r\n      }\r\n    }`;

const NEW = `    // Track seen tokens to avoid double-processing across overlapping scans
    if (!global.seenLaunchTokens) global.seenLaunchTokens = new Set();

    for (const log of logs) {
      if (isPaused) break;
      try {
        // === CORRECT EVENT STRUCTURE (verified on-chain 2026-07-10) ===
        // topics[1] = token address (ERC20)
        // topics[2] = creator wallet (NOT curve!) -- ignore
        // data      = ABI-encoded (string name, string symbol, uint256)
        // Real curve = non-factory contract with code in same tx receipt

        const tokenAddr = ('0x' + log.topics[1].slice(-40)).toLowerCase();

        // Deduplicate across overlapping scan windows
        if (global.seenLaunchTokens.has(tokenAddr)) continue;
        global.seenLaunchTokens.add(tokenAddr);
        // Keep set from growing unbounded
        if (global.seenLaunchTokens.size > 200) global.seenLaunchTokens.clear();

        // Decode name + symbol from event data (ABI-encoded strings in data)
        let tokenName = '???';
        let tokenSymbol = '???';
        try {
          const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
            ['string', 'string', 'uint256'],
            log.data
          );
          tokenName = decoded[0] || '???';
          tokenSymbol = decoded[1] || '???';
        } catch {}

        // Find real curve contract from receipt (non-factory addr with code in same tx)
        let curveAddr = tokenAddr;
        try {
          const receipt = await directProvider.getTransactionReceipt(log.transactionHash);
          if (receipt) {
            const seen = new Set([FACTORY.toLowerCase(), tokenAddr]);
            for (const rlog of receipt.logs) {
              const a = rlog.address.toLowerCase();
              if (seen.has(a)) continue;
              seen.add(a);
              const code = await directProvider.getCode(a).catch(() => '0x');
              if (code && code.length > 2) {
                curveAddr = a;
                break;
              }
            }
          }
        } catch (receiptErr) {
          logger.debug('[LAUNCH] receipt probe failed: ' + receiptErr.message);
        }

        curveToToken.set(curveAddr.toLowerCase(), tokenAddr.toLowerCase());
        curveToToken.set(tokenAddr.toLowerCase(), tokenAddr.toLowerCase());
        db.logLaunch(curveAddr, tokenAddr, \`\${tokenName} (\${tokenSymbol})\`);

        const display = (tokenName !== '???' && tokenSymbol !== '???')
          ? \`\${tokenName} (\${tokenSymbol})\`
          : \`Token (\${tokenAddr.slice(0,6)}...\${tokenAddr.slice(-4)})\`;

        logger.info(\`[NEW LAUNCH] \${display} | token: \${tokenAddr} | curve: \${curveAddr}\`);

        // Cache name/symbol immediately so /positions shows correct names
        tokenInfoCache.set(tokenAddr.toLowerCase(), { name: tokenName, symbol: tokenSymbol });
        tokenInfoCache.set(curveAddr.toLowerCase(), { name: tokenName, symbol: tokenSymbol });

        // === IMMEDIATE rich Telegram alert ===
        const explorerLink = \`\${EXPLORER}/address/\${tokenAddr}\`;
        const alertMsg =
          \`🚀 <b>New Launch!</b>\\n\` +
          \`<b>\${tokenName}</b> (<code>\${tokenSymbol}</code>)\\n\` +
          \`🪙 Token: <a href="\${explorerLink}">\${tokenAddr.slice(0,10)}...\${tokenAddr.slice(-6)}</a>\\n\` +
          \`📈 Curve: <code>\${curveAddr.slice(0,10)}...\${curveAddr.slice(-6)}</code>\\n\` +
          \`⏱️ Block: \${log.blockNumber}\`;

        sendTg(alertMsg, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(() => {});
        sendBuyMenu(curveAddr, display, tokenAddr).catch(() => {});

        recentLaunches.unshift({ addr: curveAddr, token: tokenAddr, symbol: display, time: Date.now() });
        if (recentLaunches.length > 10) recentLaunches.pop();

        // Auto snipe — real curve, 2s delay for chain to settle
        setTimeout(() => snipe(curveAddr, display, tokenAddr), 2000);

      } catch (logErr) {
        logger.warn('[LAUNCH PARSE ERR] ' + logErr.message);
        try {
          const addr = ('0x' + log.topics[1].slice(-40)).toLowerCase();
          recentLaunches.unshift({ addr, symbol: 'LAUNCH', time: Date.now() });
          if (recentLaunches.length > 10) recentLaunches.pop();
          sendTg(\`🚀 New launch: <code>\${addr}</code>\`, { parse_mode: 'HTML' }).catch(() => {});
          setTimeout(() => snipe(addr, 'LAUNCH'), 2000);
        } catch {}
      }
    }`;

if (!src.includes(OLD.slice(0, 100))) {
  // Try with \n endings
  const OLD2 = OLD.replace(/\r\n/g, '\n');
  if (src.includes(OLD2.slice(0, 100))) {
    src = src.replace(OLD2, NEW.replace(/\r\n/g, '\n'));
    console.log('Patched (LF)');
  } else {
    console.error('Could not find target block! Manual fix needed.');
    process.exit(1);
  }
} else {
  src = src.replace(OLD, NEW.replace(/\r\n/g, '\r\n'));
  console.log('Patched (CRLF)');
}

fs.writeFileSync(file, src);
console.log('Done - patch_launch.js applied successfully');
