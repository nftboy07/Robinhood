const fs = require('fs');
let src = fs.readFileSync('./robinhood_bot.js', 'utf8');

const OLD_BLOCK = "    logger.info('Telegram alerts + BUTTONS ENABLED (fun.noxa.fi mode)');\r\n    await sendTg('🚀 Robinhood Sniper started - focused on fun.noxa.fi/robinhood');\r\n    await sendMainMenu(TG_CHAT, 'Menu ready. Use buttons below:');\r\n    await sendAlert('🚀 Robinhood Sniper started (live on fun.noxa.fi/robinhood)');";
const NEW_BLOCK = "    logger.info('Telegram alerts + BUTTONS ENABLED (fun.noxa.fi mode)');";

if (src.includes(OLD_BLOCK)) {
  src = src.replace(OLD_BLOCK, NEW_BLOCK);
  console.log('Patched CRLF');
} else {
  const OLD_BLOCK_LF = OLD_BLOCK.replace(/\r\n/g, '\n');
  if (src.includes(OLD_BLOCK_LF)) {
    src = src.replace(OLD_BLOCK_LF, NEW_BLOCK);
    console.log('Patched LF');
  } else {
    console.error('Target block not found!');
  }
}

fs.writeFileSync('./robinhood_bot.js', src);
