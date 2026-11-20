import { test } from "node:test";
import assert from "node:assert/strict";

// Regression for the first-comer Telegram takeover: with no owner configured (RH_TG_CHAT
// unset and no telegramChatId), the bot must reject EVERY chat — no in-band enrollment.
process.env.RH_TG_CHAT = "";
delete process.env.RH_TG_CHAT;

test("isOwner returns false for any chat when no owner is configured", async () => {
  const tg = await import("../src/telegram/tg.js");
  assert.equal(tg.isOwner("123456"), false);
  assert.equal(tg.isOwner("999"), false);
  assert.equal(tg.ownerChat(), "");
  // in-band enrollment is removed entirely
  assert.equal((tg as Record<string, unknown>).lockOwner, undefined);
});
