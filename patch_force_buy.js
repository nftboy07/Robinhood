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

// 1. Patch /check text command
const p1 = replaceBlock(
  "const hasBuy = await (new ethers.Contract(addr, curveABI, provider)).buy.estimateGas(0n, wallet.address, {value: ethers.parseEther('0.0001')}).then(() => 'yes').catch(() => 'no/err');",
  "const hasBuy = await (new ethers.Contract(FACTORY, curveABI, provider)).buy.estimateGas(addr, {value: ethers.parseEther('0.0001')}).then(() => 'yes').catch(() => 'no/err');"
);
console.log('Patch 1 (/check):', p1);

// 2. Patch forceBuy contract target
const p2 = replaceBlock(
  "  const curve = new ethers.Contract(curveAddress, curveABI, wallet);\r\n  try {\r\n    const feeData = await provider.getFeeData();",
  "  const curve = new ethers.Contract(FACTORY, curveABI, wallet);\r\n  try {\r\n    const feeData = await provider.getFeeData();"
);
console.log('Patch 2 (forceBuy target):', p2);

// 3. Patch forceBuy estimateGas
const p3 = replaceBlock(
  "    try {\r\n      gasEst = await curve.buy.estimateGas(minOut, wallet.address, { value: buyAmount });\r\n    } catch (e) {\r\n      gasEst = 300000n;\r\n    }",
  "    try {\r\n      gasEst = await curve.buy.estimateGas(curveAddress, { value: buyAmount });\r\n    } catch (e) {\r\n      gasEst = 300000n;\r\n    }"
);
console.log('Patch 3 (forceBuy estimateGas):', p3);

fs.writeFileSync('./robinhood_bot.js', src);
console.log('Done');
