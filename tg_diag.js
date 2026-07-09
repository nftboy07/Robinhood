const https = require('https');
require('dotenv').config();

const token = process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || process.env.TG_BOT_TOKEN;
const chatId = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_CHAT_ID || process.env.TG_CHAT_ID;

if (!token || !chatId) {
  console.error('Missing TELEGRAM_TOKEN or ADMIN_CHAT_ID in .env');
  process.exit(1);
}

function get(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

function post(url, data) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(JSON.stringify(data));
    req.end();
  });
}

(async () => {
  console.log('1) Bot identity:');
  console.log(await get(`https://api.telegram.org/bot${token}/getMe`));

  console.log('\n2) Webhook info (must be empty for polling):');
  const wh = await get(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  console.log(wh);
  if (wh.result && wh.result.url) {
    console.log('Deleting webhook...');
    await post(`https://api.telegram.org/bot${token}/deleteWebhook`, { drop_pending_updates: true });
  }

  console.log('\n3) Test message:');
  const test = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: '✅ Test — token + chat_id work. Robinhood sniper TG ready.'
  });
  console.log(test);
})();
