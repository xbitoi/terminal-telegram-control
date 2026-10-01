'use strict';
/* Terminal Telegram Control v2 — minimal public-safe build.
 * Exactly 3 fixed actions, no arbitrary command execution.
 * Windows + Node.js 18+.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 3770;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── Fixed allowlist: the ONLY commands this app can ever run ───
const ACTIONS = {
  restart: {
    key: 'restart', name: 'Restart PC', name_ar: 'إعادة تشغيل الحاسوب',
    cmd: 'shutdown /r /t 3', confirm: true, icon: '🔄',
  },
  shutdown: {
    key: 'shutdown', name: 'Shutdown', name_ar: 'إطفاء الحاسوب',
    cmd: 'shutdown /s /t 0', confirm: true, icon: '⏻',
  },
  notepad: {
    key: 'notepad', name: 'Open Notepad', name_ar: 'فتح المفكرة',
    cmd: 'notepad', confirm: false, icon: '📝',
  },
};

// ─── Config ───
function loadConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      telegram_token: c.telegram_token || '',
      telegram_chat_id: String(c.telegram_chat_id || ''),
      telegram_lang: c.telegram_lang === 'en' ? 'en' : 'ar',
    };
  } catch {
    return { telegram_token: '', telegram_chat_id: '', telegram_lang: 'ar' };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    telegram_token: cfg.telegram_token || '',
    telegram_chat_id: String(cfg.telegram_chat_id || ''),
    telegram_lang: cfg.telegram_lang === 'en' ? 'en' : 'ar',
  }, null, 2), 'utf8');
}

// ─── Run one whitelisted action ───
function runAction(key) {
  const a = ACTIONS[key];
  if (!a) return false;
  exec(a.cmd, { windowsHide: true, timeout: 30000 }, (err) => {
    if (err) console.error(`[run] ${key} failed: ${err.message}`);
    else console.log(`[run] ${key} executed: ${a.cmd}`);
  });
  return true;
}

// ─── HTTP helpers ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ─── Telegram bot (single-user, 3 buttons) ───
let pollActive = false;
let pollGen = 0;
let botRunning = false;

async function tg(method, token, payload) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.json();
}
function sendMsg(token, chatId, text, extra) {
  return tg('sendMessage', token, { chat_id: chatId, text, parse_mode: 'Markdown', ...(extra || {}) }).catch((e) => console.error('[bot] sendMsg:', e.message));
}
function mainMenu(en) {
  return {
    inline_keyboard: [
      [{ text: en ? '🔄 Restart PC' : '🔄 إعادة التشغيل', callback_data: 'ask:restart' }],
      [{ text: en ? '⏻ Shutdown' : '⏻ إطفاء الحاسوب', callback_data: 'ask:shutdown' }],
      [{ text: en ? '📝 Open Notepad' : '📝 فتح المفكرة', callback_data: 'do:notepad' }],
    ],
  };
}
function confirmMenu(key, en) {
  return {
    inline_keyboard: [[
      { text: en ? '✅ Confirm' : '✅ تأكيد', callback_data: `do:${key}` },
      { text: en ? '❌ Cancel' : '❌ إلغاء', callback_data: 'menu' },
    ]],
  };
}

function startBot() {
  const { telegram_token: token, telegram_chat_id: chatId } = loadConfig();
  pollGen += 1;
  pollActive = false;
  botRunning = false;
  if (!token) { console.log('[bot] No token — bot disabled. Set it in the Web UI.'); return; }
  const myGen = pollGen;
  pollActive = true;
  console.log('[bot] Connecting to Telegram...');
  // Sync / commands menu (best effort)
  fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands: [
      { command: 'start', description: 'Main menu' },
      { command: 'restart', description: 'Restart PC (with confirm)' },
      { command: 'shutdown', description: 'Shutdown (with confirm)' },
      { command: 'notepad', description: 'Open Notepad' },
    ] }),
  }).catch(() => {});
  let offset = 0;
  let welcomed = false;
  const poll = async () => {
    if (!pollActive || myGen !== pollGen) return;
    let wait = 1000;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 35000);
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset + 1}&timeout=30`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 401) { console.log('[bot] Invalid token (401). Fix it in the Web UI.'); wait = 15000; return; }
      if (res.status === 409) { console.log('[bot] Conflict (409) — another instance is polling. Stop it first.'); wait = 15000; return; }
      if (!res.ok) { wait = 5000; return; }
      const data = await res.json();
      if (!botRunning) { botRunning = true; console.log('[bot] Connected — listening for commands.'); }
      if (!welcomed && chatId) {
        welcomed = true;
        const en = loadConfig().telegram_lang === 'en';
        await sendMsg(token, chatId, en ? '*Terminal Control* ready — choose an action:' : '*التحكم بالحاسوب* جاهز — اختر إجراء:', { reply_markup: mainMenu(en) });
      }
      for (const u of data.result || []) {
        offset = Math.max(offset, u.update_id);
        const msg = u.message || (u.callback_query && u.callback_query.message);
        const from = String((msg && msg.chat && msg.chat.id) || '');
        if (chatId && from !== String(chatId)) continue;
        const en = loadConfig().telegram_lang === 'en';
        // Text
        if (u.message && u.message.text) {
          const txt = u.message.text.trim().toLowerCase();
          if (txt.startsWith('/start') || txt.startsWith('/menu')) {
            await sendMsg(token, from, en ? '*Terminal Control* — choose:' : '*التحكم بالحاسوب* — اختر:', { reply_markup: mainMenu(en) });
          } else if (txt.startsWith('/notepad')) {
            runAction('notepad');
            await sendMsg(token, from, en ? '📝 Notepad opened.' : '📝 تم فتح المفكرة.');
          } else if (txt.startsWith('/restart')) {
            await sendMsg(token, from, en ? '⚠️ *Confirm restart?*' : '⚠️ *تأكيد إعادة التشغيل؟*', { reply_markup: confirmMenu('restart', en) });
          } else if (txt.startsWith('/shutdown')) {
            await sendMsg(token, from, en ? '⚠️ *Confirm shutdown?*' : '⚠️ *تأكيد الإطفاء؟*', { reply_markup: confirmMenu('shutdown', en) });
          }
          continue;
        }
        // Buttons
        if (u.callback_query) {
          const cb = u.callback_query;
          const [op, key] = String(cb.data || '').split(':');
          await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cb.id }),
          }).catch(() => {});
          if (op === 'menu') {
            await sendMsg(token, from, en ? '*Choose:*' : '*اختر:*', { reply_markup: mainMenu(en) });
          } else if (op === 'ask' && ACTIONS[key] && ACTIONS[key].confirm) {
            const a = ACTIONS[key];
            await sendMsg(token, from, en ? `⚠️ *Confirm ${a.name}?*` : `⚠️ *تأكيد: ${a.name_ar}؟*`, { reply_markup: confirmMenu(key, en) });
          } else if (op === 'do' && ACTIONS[key]) {
            runAction(key);
            const a = ACTIONS[key];
            await sendMsg(token, from, en ? `${a.icon} *${a.name}* done.` : `${a.icon} تم: *${a.name_ar}.*`);
          }
        }
      }
      wait = 1000;
    } catch (e) {
      if (e.name !== 'AbortError') console.error('[bot] poll:', e.message);
      wait = 5000;
    } finally {
      if (pollActive && myGen === pollGen) setTimeout(poll, wait);
    }
  };
  poll();
}

// ─── HTTP server ───
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && (url === '/' || url.startsWith('/index') || url.endsWith('.html') || url.endsWith('.css') || url.endsWith('.js') || url.endsWith('.png') || url.endsWith('.ico'))) return serveStatic(req, res);
    if (req.method === 'GET' && url === '/api/actions') {
      return json(res, 200, { actions: Object.values(ACTIONS).map((a) => ({ key: a.key, name: a.name, name_ar: a.name_ar, icon: a.icon, confirm: a.confirm })) });
    }
    if (req.method === 'POST' && url.startsWith('/api/actions/') && url.endsWith('/run')) {
      const key = url.split('/')[3];
      if (!ACTIONS[key]) return json(res, 404, { error: 'Unknown action' });
      runAction(key);
      return json(res, 200, { ok: true, action: key });
    }
    if (req.method === 'GET' && url === '/api/settings') {
      const c = loadConfig();
      return json(res, 200, { telegram_chat_id: c.telegram_chat_id, telegram_lang: c.telegram_lang, has_token: !!c.telegram_token, bot_running: botRunning });
    }
    if (req.method === 'POST' && url === '/api/settings') {
      const body = await readBody(req);
      const c = loadConfig();
      if (body.telegram_token !== undefined) c.telegram_token = String(body.telegram_token || '');
      if (body.telegram_chat_id !== undefined) c.telegram_chat_id = String(body.telegram_chat_id || '');
      if (body.telegram_lang === 'en' || body.telegram_lang === 'ar') c.telegram_lang = body.telegram_lang;
      saveConfig(c);
      startBot();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url === '/api/bot/status') {
      return json(res, 200, { running: botRunning });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Terminal Control running: http://localhost:${PORT}`);
  startBot();
});
