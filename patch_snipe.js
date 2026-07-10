const fs = require('fs');
let src = fs.readFileSync('./robinhood_bot.js', 'utf8');

// Helper to replace LF or CRLF block
function replaceBlock(oldStr, newStr) {
  if (src.includes(oldStr)) {
    src = src.replace(oldStr, newStr);
    return true;
  }
  const oldLF = oldStr.replace(/\r\n/g, '\n');
  const newLF = newStr.replace(/\r\n/g, '\n');
  if (src.includes(oldLF)) {
    src = src.replace(oldLF, newLF);
    return true;
  }
  return false;
}

// 1. Replace first Contract instantiation in snipe
const patch1 = replaceBlock(
  "  const curve = new ethers.Contract(curveAddress, curveABI, wallet);",
  "  const curve = new ethers.Contract(FACTORY, curveABI, wallet);"
);
console.log('Patch 1 (curve factory):', patch1);

// 2. Replace curve_ instantiation and estimateGas in check-readiness loop
const patch2 = replaceBlock(
  "    try {\r\n      const curve_ = new ethers.Contract(curveAddress, curveABI, wallet);\r\n      await curve_.buy.estimateGas(0n, wallet.address, { value: SNIPE_AMOUNT });\r\n      price = 1n; // estimateGas succeeded = curve is live\r\n      break;\r\n    } catch {}",
  "    try {\r\n      const curve_ = new ethers.Contract(FACTORY, curveABI, wallet);\r\n      await curve_.buy.estimateGas(curveAddress, { value: SNIPE_AMOUNT });\r\n      price = 1n; // estimateGas succeeded = curve is live\r\n      break;\r\n    } catch {}"
);
console.log('Patch 2 (readiness check):', patch2);

// 3. Replace estimateGas in buy simulation
const patch3 = replaceBlock(
  "    let gasEst;\r\n    try {\r\n      gasEst = await curve.buy.estimateGas(minOut, wallet.address, { value: SNIPE_AMOUNT });\r\n    } catch (e) {\r\n      minOut = 0n;\r\n      gasEst = await curve.buy.estimateGas(minOut, wallet.address, { value: SNIPE_AMOUNT });\r\n    }",
  "    let gasEst;\r\n    try {\r\n      gasEst = await curve.buy.estimateGas(curveAddress, { value: SNIPE_AMOUNT });\r\n    } catch (e) {\r\n      minOut = 0n;\r\n      gasEst = await curve.buy.estimateGas(curveAddress, { value: SNIPE_AMOUNT });\r\n    }"
);
console.log('Patch 3 (estimateGas buy):', patch3);

// 4. Replace tx execution buy
const patch4 = replaceBlock(
  "    const tx = await curve.buy(minOut, wallet.address, {\r\n      value: SNIPE_AMOUNT,",
  "    const tx = await curve.buy(curveAddress, {\r\n      value: SNIPE_AMOUNT,"
);
console.log('Patch 4 (tx buy):', patch4);

fs.writeFileSync('./robinhood_bot.js', src);
console.log('Done');
