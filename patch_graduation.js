const fs = require('fs');
let src = fs.readFileSync('./robinhood_bot.js', 'utf8');

function replaceBlock(oldStr, newStr, label) {
  if (src.includes(oldStr)) {
    src = src.replace(oldStr, newStr);
    console.log('✓', label);
    return true;
  }
  const oldLF = oldStr.replace(/\r\n/g, '\n');
  const newLF = newStr.replace(/\r\n/g, '\n');
  if (src.includes(oldLF)) {
    src = src.replace(oldLF, newLF);
    console.log('✓', label, '(LF)');
    return true;
  }
  console.log('✗ FAILED:', label);
  return false;
}

// 1. Fix curves() ABI - correct struct layout: creator, tokenBalance, virtualEth, uint256 counter
//    Graduation = tokenBalance == 0 (all tokens bought out)
replaceBlock(
  `  'function curves(address token) external view returns (uint256 virtualEth, uint256 tokenBalance, bool graduated)',`,
  `  // curves() returns: (address creator, uint256 tokenBalance, uint256 virtualEth, uint256 id)
  // Graduation = tokenBalance == 0n (all tokens sold from curve)
  'function curves(address token) external view returns (address creator, uint256 tokenBalance, uint256 virtualEth, uint256 id)',`,
  'Fix curves() ABI layout'
);

// 2. Fix getCurrentPrice to use correct fields (virtualEth/tokenBalance)
replaceBlock(
  `    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const state = await factory.curves(tokenAddr);
    // state = [virtualEth, tokenBalance, graduated]
    // Price = virtualEth / tokenBalance (ETH per token)
    if (state && state.tokenBalance > 0n) {
      return (state.virtualEth * (10n ** 18n)) / state.tokenBalance;
    }
    return 0n;`,
  `    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const state = await factory.curves(tokenAddr);
    // state = [creator, tokenBalance, virtualEth, id]
    // Price = virtualEth / tokenBalance (ETH per token)
    if (state && state.tokenBalance > 0n) {
      return (state.virtualEth * (10n ** 18n)) / state.tokenBalance;
    }
    return 0n;`,
  'Fix getCurrentPrice field comment'
);

// 3. Fix estimateBuyOutput - state.tokenBalance and state.virtualEth are now correct positions
replaceBlock(
  `    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const state = await factory.curves(curveAddress);
    if (!state || state.tokenBalance === 0n) return 0n;
    // Simple bonding curve estimate: tokens = (ethAmount / virtualEth) * tokenBalance
    const tokens = (ethAmount * state.tokenBalance) / (state.virtualEth + ethAmount);
    return tokens;`,
  `    const factory = new ethers.Contract(FACTORY, curveABI, provider);
    const state = await factory.curves(curveAddress);
    if (!state || state.tokenBalance === 0n || state.virtualEth === 0n) return 0n;
    // Simple bonding curve estimate: tokens = (ethAmount / virtualEth) * tokenBalance
    const tokens = (ethAmount * state.tokenBalance) / (state.virtualEth + ethAmount);
    return tokens;`,
  'Fix estimateBuyOutput guard'
);

// 4. Fix graduation detection in monitorPositions - use tokenBalance == 0 instead of state.graduated
replaceBlock(
  `        if (ROUTER && !pos.isMigrated) {
          const factory = new ethers.Contract(FACTORY, curveABI, provider);
          const state = await factory.curves(pos.token).catch(() => null);
          if (state && state.graduated) {
            pos.isMigrated = true;
            logger.info(\`[MIGRATED] \${pos.symbol} graduated to DEX\`);
            sendTg(\`🔄 \${pos.symbol} graduated to DEX - will use DEX sells\`).catch(()=>{});
          }
        }`,
  `        // Detect graduation: tokenBalance == 0 means all tokens bought out from curve
        // Note: ROUTER/WETH not configured - graduated tokens are held until manually sold
        if (!pos.isMigrated) {
          const factory = new ethers.Contract(FACTORY, curveABI, provider);
          const state = await factory.curves(pos.token).catch(() => null);
          if (state && state.tokenBalance === 0n && state.virtualEth === 0n) {
            pos.isMigrated = true;
            logger.info(\`[GRADUATED] \${pos.symbol} bonding curve complete - holding position\`);
            sendTg(\`🎓 \${pos.symbol} bonding curve complete! Holding until DEX liquidity.\`).catch(()=>{});
          }
        }`,
  'Fix graduation detection - tokenBalance==0, not state.graduated'
);

// 5. Fix sellPosition to NOT try DEX if ROUTER is empty
//    Graduated tokens: just log and skip DEX sell (no working DEX on chain yet)
replaceBlock(
  `  if (pos.isMigrated && ROUTER) {
    const exitPrice = await getLivePrice(posKey, posCurve);
    const txHash = await sellOnDex(posKey, sellAmt);
    if (txHash) {
      logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
      positions = positions.filter(p => (p.token || p.curve) !== posKey);
      savePositions();
    }
    return;
  }`,
  `  // If graduated and ROUTER is configured, try DEX sell
  // Without ROUTER, fall through to curve sell (may fail if graduated - that's ok, position stays)
  if (pos.isMigrated && ROUTER && WETH) {
    const exitPrice = await getLivePrice(posKey, posCurve);
    const txHash = await sellOnDex(posKey, sellAmt);
    if (txHash) {
      logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
      positions = positions.filter(p => (p.token || p.curve) !== posKey);
      savePositions();
    } else {
      await sendTg(\`⚠️ \${pos.symbol} graduated but DEX sell failed. Hold manually or configure ROUTER/WETH.\`);
    }
    return;
  }`,
  'Fix sellPosition - require both ROUTER and WETH to attempt DEX sell'
);

// 6. Fix the stop-loss infinite loop: if curve sell fails on a graduated token, 
//    remove position from active monitoring rather than looping
replaceBlock(
  `  } catch (e) {
    logger.error(\`Sell error on curve: \${e.message}. Attempting DEX fallback...\`);
    if (ROUTER) {
      pos.isMigrated = true;
      const exitPrice = await getLivePrice(posKey, posCurve);
      const txHash = await sellOnDex(posKey, sellAmt);
      if (txHash) {
        logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
        const key = pos.token || pos.curve; positions = positions.filter(p => (p.token || p.curve) !== key);
        savePositions();
      }
    } else {
      await sendTg(\`❌ Sell failed for \${pos.symbol}: \${e.message}\`);
    }
  }`,
  `  } catch (e) {
    logger.error(\`Sell error on curve: \${e.message}\`);
    if (ROUTER && WETH) {
      // Curve sell failed - try DEX fallback
      pos.isMigrated = true;
      const exitPrice = await getLivePrice(posKey, posCurve);
      const txHash = await sellOnDex(posKey, sellAmt);
      if (txHash) {
        logTradeToHistory(pos, sellAmt, exitPrice, txHash, exitType);
        const key = pos.token || pos.curve; positions = positions.filter(p => (p.token || p.curve) !== key);
        savePositions();
      }
    } else if (pos.isMigrated) {
      // Graduated token, no DEX available - stop SL loop by pausing this position
      logger.warn(\`[GRADUATED HOLD] \${pos.symbol} curve sell failed (token graduated). Pausing SL monitoring.\`);
      pos.slPaused = true;
      await sendTg(\`⚠️ \${pos.symbol} graduated - curve sell unavailable. Holding. Sell manually when DEX available.\`);
      savePositions();
    } else {
      await sendTg(\`❌ Sell failed for \${pos.symbol}: \${e.message.slice(0,100)}\`);
    }
  }`,
  'Fix sell error handler - stop SL loop for graduated tokens'
);

// 7. Fix manageSafeStrategy stop-loss to skip paused positions
replaceBlock(
  `  // 1. Hard Stop Loss - protect capital fast (sell everything, even moonbag on hard rugs)
  if (pnlPct <= -STOP_LOSS * 100) {
    logger.info(\`[SL] \${pos.symbol} PnL \${pnlPct.toFixed(1)}% - Selling for capital protection\`);
    await sendTg(\`🛡️ SL hit on \${pos.symbol} (\${pnlPct.toFixed(1)}%) - Protecting capital\`);
    await sellPosition(pos, 'STOP_LOSS');
    return;
  }`,
  `  // 1. Hard Stop Loss - protect capital fast (sell everything, even moonbag on hard rugs)
  // Skip SL for graduated tokens with no DEX (slPaused = true)
  if (pnlPct <= -STOP_LOSS * 100 && !pos.slPaused) {
    logger.info(\`[SL] \${pos.symbol} PnL \${pnlPct.toFixed(1)}% - Selling for capital protection\`);
    await sendTg(\`🛡️ SL hit on \${pos.symbol} (\${pnlPct.toFixed(1)}%) - Protecting capital\`);
    await sellPosition(pos, 'STOP_LOSS');
    return;
  }`,
  'Fix SL skip for graduated paused positions'
);

fs.writeFileSync('./robinhood_bot.js', src);
console.log('\nAll patches written.');
