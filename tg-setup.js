const fs = require("fs");
require("dotenv").config();
const T = process.env.TG_BOT_TOKEN;
const api = (m) => fetch(`https://api.telegram.org/bot${T}/${m}`).then(r => r.json());
(async () => {
  if (!T) return console.log("X  .env me TG_BOT_TOKEN nahi mila");
  const me = await api("getMe");
  if (!me.ok) return console.log("X  Token galat hai:", me.description || "");
  console.log("OK Bot mila: @" + me.result.username);
  const u = await api("getUpdates");
  const msg = (u.result || []).map(x => x.message).filter(Boolean).pop();
  if (!msg) return console.log("X  Bot ko aapka message nahi mila. Bot me START dabao, hi likho, phir dobara chalao.");
  const id = msg.from.id;
  console.log("OK Aapki Telegram ID:", id);
  let env = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
  env = env.replace(/^\s*#?\s*TG_ADMIN_CHANNEL=.*\r?\n?/gm, "");
  env = env.replace(/\s*$/, "\n") + "TG_ADMIN_CHANNEL=" + id + "\n";
  fs.writeFileSync(".env", env);
  console.log("OK .env me TG_ADMIN_CHANNEL likh diya");
  const s = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: id, text: "TOSSKING bot connected!" })
  }).then(r => r.json());
  console.log(s.ok ? "OK Telegram me message bhej diya, check karo" : "X  Message nahi gaya: " + s.description);
})().catch(e => console.log("X  Error:", e.message));