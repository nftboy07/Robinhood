const fs = require('fs');
let src = fs.readFileSync('./robinhood_bot.js', 'utf8');

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

const p1 = replaceBlock(
  "    try {\r\n      gasEst = await curve.buy.estimateGas(minOut, wallet.address, { value: buyAmount });\r\n    } catch (e) {",
  "    try {\r\n      gasEst = await curve.buy.estimateGas(curveAddress, { value: buyAmount });\r\n    } catch (e) {"
);
console.log('Patch 1 (estimateGas):', p1);

const p2 = replaceBlock(
  "    const tx = await curve.buy(minOut, wallet.address, {\r\n      value: buyAmount,",
  "    const tx = await curve.buy(curveAddress, {\r\n      value: buyAmount,"
);
console.log('Patch 2 (buy call):', p2);

fs.writeFileSync('./robinhood_bot.js', src);
console.log('Done');
