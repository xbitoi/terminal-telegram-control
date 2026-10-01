const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execSync, spawn } = require('child_process');

const PORT = 3770;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ─── Config ──────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Normalize old apps: upgrade `command` to `commands` array, add `startup` default
    cfg.apps = (cfg.apps || []).map(a => ({
      ...a,
      commands: a.commands || (a.command ? [a.command] : []),
      startup: a.startup ?? false,
      shell: a.shell || 'cmd',
    }));
    cfg.download_dir = cfg.download_dir || path.join(os.homedir(), 'Downloads', 'TerminalRunner');
    cfg.telegram_lang = cfg.telegram_lang === 'en' ? 'en' : 'ar';
    cfg.schedules = (cfg.schedules || []).filter(s => s && s.id && s.appId && s.runAt);
    return cfg;
  } catch {
    return { apps: [], telegram_token: '', telegram_chat_id: '', download_dir: path.join(os.homedir(), 'Downloads', 'TerminalRunner'), telegram_lang: 'ar', schedules: [] };
  }
}

function saveConfig(cfg) {
  // Clean up old `command` field, keep only `commands`; preserve `startup` and `shell`
  cfg.apps = (cfg.apps || []).map(a => ({
    id: a.id,
    name: a.name,
    commands: a.commands || (a.command ? [a.command] : []),
    startup: a.startup ?? false,
    shell: a.shell || 'cmd',
  }));
  const out = {
    apps: cfg.apps,
    telegram_token: cfg.telegram_token || '',
    telegram_chat_id: cfg.telegram_chat_id || '',
    download_dir: cfg.download_dir || path.join(os.homedir(), 'Downloads', 'TerminalRunner'),
    telegram_lang: cfg.telegram_lang === 'en' ? 'en' : 'ar',
    schedules: (cfg.schedules || []).filter(s => s && s.id && s.appId && s.runAt),
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2), 'utf8');
}

// ─── MIME types ──────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ─── Serve static ────────────────────────────────────────────────────────
function serveStatic(res, urlPath) {
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    });
    res.end(data);
  });
}

// ─── API helpers ─────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ─── Startup with Windows ───────────────────────────────────────────────
function getStartupShortcutPath() {
  return path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'TerminalRunner.lnk');
}

function isStartupEnabled() {
  const sp = getStartupShortcutPath();
  try { return fs.existsSync(sp); } catch { return false; }
}

function toggleStartup(enable) {
  const sp = getStartupShortcutPath();
  if (!enable) {
    try { fs.unlinkSync(sp); } catch {}
    return;
  }
  // Build PowerShell commands, encode as Base64 to avoid all quoting issues
  const lines = [
    `$sp = '${sp}'`,
    `$w = New-Object -ComObject WScript.Shell`,
    `$s = $w.CreateShortcut($sp)`,
    `$s.TargetPath = 'powershell.exe'`,
    `$s.Arguments = '-WindowStyle Hidden -NoLogo -NoProfile -Command "node ''${__filename}''"'`,
    `$s.WorkingDirectory = '${__dirname}'`,
    `$s.Description = 'Terminal Telegram Runner - Telegram + Web'`,
    `$s.Save()`,
  ];
  // Write to temp file with explicit CRLF bytes
  const tmpFile = path.join(os.tmpdir(), `tr_startup_${Date.now().toString(36)}.ps1`);
  const crlf = Buffer.from([0x0d, 0x0a]);
  const buf = Buffer.concat(lines.map((l, i) => {
    const line = Buffer.from(l, 'utf8');
    return i < lines.length - 1 ? Buffer.concat([line, crlf]) : line;
  }));
  fs.writeFileSync(tmpFile, buf);
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 15000 });
    console.log(`[startup] Shortcut created: ${sp}`);
  } catch (e) {
    console.error(`[startup] Failed: ${e.message}`);
    if (e.stdout) console.error(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
  }
  try { fs.unlinkSync(tmpFile); } catch {}
}

// ─── Run command (opens new terminal window) ────────────────────────────
const runningProcesses = new Map(); // name -> [pid, ...]
const pendingSends = new Map(); // sendId -> AbortController (true cancel of server->Telegram leg)

function runCommand(name, cmd, shell = 'cmd') {
  if (shell === 'gitbash') {
    // git-bash.exe -c "command; read" → proper Git Bash window that stays open
    const child = spawn('C:/Program Files/Git/git-bash.exe', ['-c', `${cmd}; read -p "اضغط Enter للإغلاق..."`], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    if (child && child.pid) {
      const pids = runningProcesses.get(name) || [];
      pids.push(child.pid);
      runningProcesses.set(name, pids);
      console.log(`[run] ${name} started (gitbash) with PID ${child.pid}`);
    }
    if (child && child.unref) child.unref();
    return;
  }

  if (shell === 'powershell') {
    // PowerShell: create temp .ps1 script and spawn powershell.exe
    const tmpFile = path.join(os.tmpdir(), `tr_${crypto.randomUUID().slice(0, 8)}.ps1`);
    const content = `$Host.UI.RawUI.WindowTitle = "${name}"\n${cmd}\nWrite-Host ""\nRead-Host "اضغط Enter للإغلاق..."\n`;
    fs.writeFileSync(tmpFile, content, 'utf8');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
      detached: true,
      windowsHide: false,
      stdio: 'ignore',
    });
    if (child && child.pid) {
      const pids = runningProcesses.get(name) || [];
      pids.push(child.pid);
      runningProcesses.set(name, pids);
      console.log(`[run] ${name} started (powershell) with PID ${child.pid}`);
    }
    if (child && child.unref) child.unref();
    setTimeout(() => {
      try { fs.unlinkSync(tmpFile); } catch {}
    }, 30000);
    return;
  }

  // Default: cmd.exe
  // Write a temp .cmd file to avoid cmd.exe quoting issues
  const tmpFile = path.join(os.tmpdir(), `tr_${crypto.randomUUID().slice(0, 8)}.cmd`);
  const content = `@echo off\r\nTITLE ${name}\r\n${cmd}\r\necho.\r\npause\r\n`;
  fs.writeFileSync(tmpFile, content, 'utf8');
  // Use spawn with detached + windowsHide:false to create a visible cmd window and track PID
  const child = spawn('cmd.exe', ['/c', tmpFile], {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });
  // Track the actual PID of the cmd.exe window
  if (child && child.pid) {
    const pids = runningProcesses.get(name) || [];
    pids.push(child.pid);
    runningProcesses.set(name, pids);
    console.log(`[run] ${name} started (cmd) with PID ${child.pid}`);
  }
  if (child && child.unref) child.unref();
  // Clean up after 30 seconds
  setTimeout(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  }, 30000);
}

function stopCommand(name) {
  const pids = runningProcesses.get(name);
  if (!pids || pids.length === 0) {
    console.log(`[stop] No tracked PIDs for "${name}", trying fallback via taskkill`);
    // Fallback: try taskkill by window title
    try {
      execSync(`taskkill /FI "WINDOWTITLE eq ${name}" /F /T`, { stdio: 'ignore' });
      console.log(`[stop] Fallback taskkill done for "${name}"`);
    } catch {}
    return;
  }
  console.log(`[stop] Killing PIDs for "${name}": ${pids.join(', ')}`);
  for (const pid of pids) {
    try {
      execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
      console.log(`[stop] Killed PID ${pid}`);
    } catch (e) {
      console.error(`[stop] Failed to kill PID ${pid}: ${e.message}`);
    }
  }
  runningProcesses.delete(name);
}

// Live running processes, callable from anywhere (Telegram bot + Web API).
// Prunes dead PIDs, returns [{ name, pids[] }].
function getRunningLive() {
  const out = [];
  for (const [name, pids] of runningProcesses) {
    const alive = [...new Set((pids || []).map(Number))].filter(pid => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        const list = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString();
        return list.includes(`"${pid}"`);
      } catch { return false; }
    });
    if (alive.length) {
      runningProcesses.set(name, alive);
      out.push({ name, pids: alive });
    } else {
      runningProcesses.delete(name);
    }
  }
  return out;
}

// ─── Screenshot (Windows, no extra deps) ─────────────────────────────
function takeScreenshot() {
  const outFile = path.join(os.tmpdir(), `tr_screen_${Date.now().toString(36)}.png`);
  const ps = [
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
    `$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds`,
    `$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)`,
    `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
    `$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)`,
    `$bmp.Save('${outFile}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    `$g.Dispose(); $bmp.Dispose()`,
  ].join('; ');
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, { timeout: 15000 });
  return outFile;
}

async function sendScreenshot(token, chatId) {
  const file = takeScreenshot();
  try {
    const buf = fs.readFileSync(file);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', '📸 Screenshot / لقطة شاشة');
    form.append('photo', new Blob([buf], { type: 'image/png' }), 'screenshot.png');
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      console.error(`[bot] sendPhoto failed (${res.status}): ${t.slice(0, 200)}`);
    }
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// ─── File Manager via Telegram ─────────────────────────────────────
function fmList(dir) {
  const target = dir || os.homedir();
  const resolved = path.resolve(target);
  const st = fs.statSync(resolved);
  const base = st.isDirectory() ? resolved : path.dirname(resolved);
  const names = fs.readdirSync(base);
  const entries = names.slice(0, 40).map(n => {
    const fp = path.join(base, n);
    try { return { name: n, path: fp, isDir: fs.statSync(fp).isDirectory() }; }
    catch { return { name: n, path: fp, isDir: false }; }
  }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  return { cwd: base, parent: path.dirname(base), entries };
}

async function sendFileMenu(token, chatId, dir) {
  let info;
  try { info = fmList(dir); }
  catch (e) { await sendMsg(token, chatId, '❌ تعذر فتح المجلد: ' + (e?.message || '')); return; }
  const keyboard = [];
  if (info.cwd !== info.parent) {
    keyboard.push([{ text: '🔙 .. (أعلى)', callback_data: `fm:${info.parent}` }]);
  }
  for (const e of info.entries.slice(0, 30)) {
    if (e.isDir) {
      keyboard.push([{ text: `📁 ${e.name}`, callback_data: `fm:${e.path}` }]);
    } else {
      keyboard.push([{ text: `📄 ${e.name}`, callback_data: `fdown:${e.path}` }]);
    }
  }
  keyboard.push([{ text: '🔙 رجوع للقائمة', callback_data: 'back_to_menu' }]);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `📁 *الملفات*\n\`${escMd(info.cwd)}\`\n\nمجلد: أرسل أي ملف هنا لرفعه إلى هذا المجلد\\.\\ اضغط على ملف لتحميله\\.`,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) { console.error('[bot] sendFileMenu error:', e?.message); }
}

async function sendSchedules(token, chatId) {
  const cfg = loadConfig();
  const list = cfg.schedules || [];
  const en = cfg.telegram_lang === 'en';
  if (list.length === 0) {
    await sendMsg(token, chatId, en ? '⏰ No scheduled runs. Schedule from the Web UI.' : '⏰ لا توجد تشغيلات مجدولة. جدوِل من واجهة الويب.');
    return;
  }
  const keyboard = list.map(s => {
    const mins = Math.max(0, Math.round((s.runAt - Date.now()) / 60000));
    return [{ text: `⏰ ${s.appName} — ${en ? 'in' : 'بعد'} ${mins}m ❌`, callback_data: `sch_del:${s.id}` }];
  });
  keyboard.push([{ text: en ? '🔙 Back' : '🔙 رجوع', callback_data: 'back_to_menu' }]);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: en ? `⏰ *Scheduled runs (${list.length})*\nTap to cancel:` : `⏰ *تشغيلات مجدولة (${list.length})*\nاضغط للإلغاء:`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) { console.error('[bot] sendSchedules error:', e?.message); }
}

// History / Running menu: live processes + Windows-boot apps + last runs,
// with inline stop buttons. Opened from the 🕘 reply-keyboard button.
function safeName(s) {
  return String(s || '?').replace(/[_*`\[\]]/g, ' ').slice(0, 40);
}

async function sendHistory(token, chatId) {
  const cfg = loadConfig();
  const en = tLang() === 'en';
  const running = getRunningLive();
  const runningNames = new Set(running.map(r => r.name));
  const startupApps = (cfg.apps || []).filter(a => a.startup);
  const h = readHistory().slice(0, 10);

  const sections = [];
  if (running.length === 0) {
    sections.push(en ? '🟢 *Running now:* nothing' : '🟢 *الشغالة الآن:* لا يوجد');
  } else {
    const lines = running.map(r => {
      const app = (cfg.apps || []).find(a => a.name === r.name);
      const tag = app && app.startup
        ? (en ? ' (boot ✅)' : ' (إقلاع ✅)')
        : (en ? ' (manual)' : ' (يدوي)');
      return `• ${safeName(r.name)} — ${r.pids.length} ${en ? 'proc' : 'عملية'}${tag}`;
    });
    sections.push((en ? '🟢 *Running now:*\n' : '🟢 *الشغالة الآن:*\n') + lines.join('\n'));
  }

  if (startupApps.length > 0) {
    const lines = startupApps.map(a =>
      `• ${safeName(a.name)} — ${runningNames.has(a.name) ? (en ? 'running 🟢' : 'شغال 🟢') : (en ? 'idle ⚪' : 'متوقف ⚪')}`);
    sections.push((en ? '\n🔥 *Boot with Windows:*\n' : '\n🔥 *تقلع مع ويندوز:*\n') + lines.join('\n'));
  }

  if (h.length > 0) {
    const lines = h.map(e => {
      const d = new Date(e.t);
      const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `• ${ts} — ${safeName(e.app)} _(${safeName(e.source)})_`;
    });
    sections.push((en ? '\n🕘 *Last runs:*\n' : '\n🕘 *آخر التشغيلات:*\n') + lines.join('\n'));
  } else if (running.length === 0 && startupApps.length === 0) {
    await sendMsg(token, chatId, en ? '🕘 History is empty.' : '🕘 السجل فارغ.');
    return;
  }

  // Inline keyboard: one ⏹ stop button per running app (by id), then nav row
  const keyboard = [];
  for (const r of running) {
    const app = (cfg.apps || []).find(a => a.name === r.name);
    if (!app) continue; // no id to stop by — shown as text only
    keyboard.push([{ text: `⏹ ${app.name} (${r.pids.length})`, callback_data: `hstop:${app.id}` }]);
  }
  keyboard.push([
    { text: en ? '🔄 Refresh' : '🔄 تحديث', callback_data: 'history_menu' },
    { text: en ? '🔙 Back' : '🔙 رجوع', callback_data: 'back_to_menu' },
  ]);

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: (en ? '🕘 *History & Running*\n' : '🕘 *السجل والشغالة*\n') + sections.join('\n'),
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
    if (!res.ok) {
      // Fallback: plain text (no parse_mode) so the menu always arrives
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: ((en ? 'History & Running\n' : 'السجل والشغالة\n') + sections.join('\n')).replace(/[*_`]/g, ''),
          reply_markup: { inline_keyboard: keyboard },
        }),
      });
    }
  } catch (e) { console.error('[bot] sendHistory error:', e?.message); }
}

async function sendDocToChat(token, chatId, filePath) {
  const st = fs.statSync(filePath);
  if (st.isDirectory()) { await sendFileMenu(token, chatId, filePath); return; }
  if (st.size > 45 * 1024 * 1024) { await sendMsg(token, chatId, '❌ الملف كبير (45MB max عبر تيليجرام)'); return; }
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', `📄 ${path.basename(filePath)} (${Math.round(st.size / 1024)} KB)`);
  form.append('document', new Blob([buf], { type: 'application/octet-stream' }), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[bot] sendDocument failed (${res.status}): ${t.slice(0, 200)}`);
  }
}

async function saveIncomingDoc(token, chatId, fileId, fileName) {
  // Resolve Telegram file path then download to ~/Downloads/TerminalRunner
  const r1 = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const j1 = await r1.json();
  if (!j1.ok) throw new Error(j1.description || 'getFile failed');
  const remotePath = j1.result.file_path;
  const r2 = await fetch(`https://api.telegram.org/file/bot${token}/${remotePath}`);
  const buf = Buffer.from(await r2.arrayBuffer());
  const cfg2 = loadConfig();
  const destDir = cfg2.download_dir || path.join(os.homedir(), 'Downloads', 'TerminalRunner');
  fs.mkdirSync(destDir, { recursive: true });
  const safe = path.basename(fileName || remotePath.split('/').pop() || 'file.bin');
  const dest = path.join(destDir, safe);
  fs.writeFileSync(dest, buf);
  await sendMsg(token, chatId, `✅ تم الحفظ في:\n\`${dest}\` (${Math.round(buf.length / 1024)} KB)`);
}

// ─── Telegram language + reply keyboard ────────────────────────────
// Single-user bot: language stored in config as telegram_lang ('ar'|'en')
function tLang() {
  try { return loadConfig().telegram_lang === 'en' ? 'en' : 'ar'; }
  catch { return 'ar'; }
}
function T(ar, en) {
  return tLang() === 'en' ? en : ar;
}
function toggleLang() {
  const cfg = loadConfig();
  cfg.telegram_lang = cfg.telegram_lang === 'en' ? 'ar' : 'en';
  saveConfig(cfg);
  return cfg.telegram_lang;
}
// Persistent buttons in the typing area (ReplyKeyboardMarkup)
async function sendMainKeyboard(token, chatId) {
  const en = tLang() === 'en';
  const keyboard = [
    [{ text: en ? '📸 Screenshot' : '📸 سكرين شوت' }, { text: en ? '📁 Files' : '📁 الملفات' }],
    [{ text: en ? '🕘 History' : '🕘 السجل' }, { text: en ? '⏹️ Stop' : '⏹️ إيقاف' }],
    [{ text: en ? '🔥 Startup' : '🔥 بدء التشغيل' }, { text: en ? '🌍 Open UI' : '🌍 فتح الواجهة' }],
    [{ text: en ? '🌐 Language / عربي' : '🌐 اللغة / English' }, { text: en ? '🚀 Menu' : '🚀 القائمة' }],
  ];
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: en ? '⌨️ Quick buttons below the typing box (tap the ⌨️ icon to fold/unfold):' : '⌨️ الأزرار السريعة أسفل خانة الكتابة (اضغط أيقونة ⌨️ لطيها/فتحها):',
        // No is_persistent: the keyboard stays collapsible next to the typing field
        reply_markup: { keyboard, resize_keyboard: true },
      }),
    });
  } catch (e) { console.error('[bot] sendMainKeyboard error:', e?.message); }
}

// ─── Sync startup apps: run apps with startup=true on server start ─────
function syncStartupApps() {
  const cfg = loadConfig();
  const startupApps = cfg.apps.filter(a => a.startup);
  if (startupApps.length === 0) {
    console.log('[startup] No apps with startup enabled');
    return;
  }
  console.log(`[startup] Running ${startupApps.length} startup app(s): ${startupApps.map(a => a.name).join(', ')}`);
  for (const app of startupApps) {
    const cmds = app.commands || [];
    for (const cmd of cmds) {
      runCommand(app.name, cmd, app.shell || 'cmd');
    }
  }
}

// ─── Run history (history.json, max 200) ───────────────────────────
const HISTORY_PATH = path.join(__dirname, 'history.json');
function logRun(app, source) {
  try {
    let h = [];
    try { h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8')); } catch {}
    if (!Array.isArray(h)) h = [];
    h.unshift({ t: Date.now(), app: String(app || '?'), source: String(source || '?') });
    if (h.length > 200) h = h.slice(0, 200);
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(h), 'utf8');
  } catch {}
}
function readHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch { return []; }
}

// ─── Scheduler (persistent, rescheduled on boot) ───────────────────
const scheduleTimers = new Map(); // id -> Timeout
function runAppById(appId, source) {
  const cfg = loadConfig();
  const app = cfg.apps.find(a => a.id === appId);
  if (!app) return false;
  for (const cmd of (app.commands || [])) {
    runCommand(app.name, cmd, app.shell || 'cmd');
  }
  logRun(app.name, source);
  return true;
}
function fireSchedule(id) {
  if (scheduleTimers.has(id)) { clearTimeout(scheduleTimers.get(id)); scheduleTimers.delete(id); }
  const cfg = loadConfig();
  const s = (cfg.schedules || []).find(x => x.id === id);
  if (!s) return;
  cfg.schedules = (cfg.schedules || []).filter(x => x.id !== id);
  saveConfig(cfg);
  const ok = runAppById(s.appId, 'schedule');
  if (!ok) logRun(s.appName || s.appId, 'schedule-missed');
  console.log(`[schedule] Fired "${s.appName || s.appId}"`);
}
function armSchedule(s) {
  if (scheduleTimers.has(s.id)) { clearTimeout(scheduleTimers.get(s.id)); scheduleTimers.delete(s.id); }
  const delay = s.runAt - Date.now();
  if (delay <= 0) { fireSchedule(s.id); return; }
  scheduleTimers.set(s.id, setTimeout(() => fireSchedule(s.id), Math.min(delay, 2147483647)));
  console.log(`[schedule] Armed "${s.appName || s.appId}" in ${Math.round(delay / 1000)}s`);
}
function rescheduleAll() {
  const cfg = loadConfig();
  const list = cfg.schedules || [];
  if (list.length === 0) { console.log('[schedule] No pending schedules'); return; }
  for (const s of list) armSchedule(s);
}
function cancelSchedule(id) {
  if (scheduleTimers.has(id)) { clearTimeout(scheduleTimers.get(id)); scheduleTimers.delete(id); }
  const cfg = loadConfig();
  cfg.schedules = (cfg.schedules || []).filter(x => x.id !== id);
  saveConfig(cfg);
}

// ─── Quick system actions (silent, no terminal window) ─────────────
const QUICK_ACTIONS = {
  lock: { cmd: 'rundll32.exe user32.dll,LockWorkStation' },
  recycle: { cmd: 'powershell -NoProfile -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"' },
  desktop: { cmd: 'powershell -NoProfile -Command "$s=New-Object -ComObject Shell.Application;$s.MinimizeAll()"' },
  taskmgr: { cmd: 'taskmgr' },
};
function runQuick(key) {
  const q = QUICK_ACTIONS[key];
  if (!q) return false;
  exec(q.cmd, { windowsHide: true, timeout: 30000 }, (err) => {
    if (err) console.error(`[quick] ${key} failed: ${err.message}`);
  });
  logRun('⚡ ' + key, 'quick');
  return true;
}

  // ─── Telegram Bot ────────────────────────────────────────────────────────
let telegramInterval = null;
let _telegramPollActive = false;
let _pollGeneration = 0; // prevents old polls from continuing after restart
const processedCbIds = new Set(); // dedup callback IDs to prevent double-processing
const PROCESSED_CB_CLEANUP_THRESHOLD = 1000;
let botInfo = { name: '', username: '', is_running: false };
const convState = new Map(); // chatId -> { step: 'name'|'command', name?: string }

// ─── Connection state (single-line professional console output) ──────────
let connState = 'idle'; // 'idle' | 'connecting' | 'online' | 'offline' | 'unauthorized' | 'conflict'
let lastConnState = 'idle'; // last state that was actually printed
let connStartupTime = Date.now();
const POLL_RETRY_ONLINE = 1000;  // 1s gap between long-poll cycles when online
const POLL_RETRY_OFFLINE = 5000; // 5s gap when offline — no spam, gentle retry

function connStatusText(state, detail) {
  const d = detail ? ` — ${detail}` : '';
  switch (state) {
    case 'connecting': return `[bot] 🚀 Connecting to Telegram...${d}`;
    case 'online': return `[bot] ✅ Connected successfully — listening for Telegram commands${d}`;
    case 'offline': return `[bot] ⛔ No internet connection — waiting... (retry in ${POLL_RETRY_OFFLINE / 1000}s)`;
    case 'unauthorized': return `[bot] 🔒 Invalid bot token (HTTP 401) — fix the token in config or Web UI. Retrying occasionally.`;
    case 'conflict': return `[bot] ⚠️ HTTP 409 — another bot instance is already polling. Stop the other server first.`;
    default: return `[bot] status: ${state}${d}`;
  }
}

// Print a status line ONLY when the state (or its detail) actually changes,
// so a dead connection never floods the console with repeated lines.
function reportConn(state, detail = '') {
  const key = detail ? `${state}:${detail}` : state;
  if (key === lastConnState) return; // unchanged → stay silent
  lastConnState = key;
  connState = state;
  if (!_telegramPollActive && state !== 'connecting') {
    // Bot is stopped intentionally — don't print stale states
    return;
  }
  console.log(connStatusText(state, detail));
}

async function fetchBotInfo(token) {
  if (!token) { botInfo = { name: '', username: '', is_running: false }; return; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (data.ok) {
      botInfo = {
        name: data.result.first_name || '',
        username: data.result.username || '',
        is_running: true,
      };
    }
  } catch { botInfo.is_running = false; }
}

async function syncBotCommands(token) {
  if (!token) return;
  const cmdsEn = [
    { command: 'start', description: 'Main menu (apps)' },
    { command: 'screenshot', description: 'Capture PC screen' },
    { command: 'files', description: 'Browse PC files' },
    { command: 'history', description: 'Running apps, boot apps and last runs' },
    { command: 'stop', description: 'Stop a running app' },
    { command: 'startup', description: 'Run on Windows boot settings' },
    { command: 'schedules', description: 'Scheduled runs' },
    { command: 'add', description: 'Add a new app' },
    { command: 'edit', description: 'Edit an app' },
    { command: 'delete', description: 'Delete an app' },
    { command: 'lang', description: 'Switch language (AR/EN)' },
    { command: 'browser', description: 'Open Web UI on the PC' },
  ];
  const cmdsAr = [
    { command: 'start', description: 'القائمة الرئيسية (التطبيقات)' },
    { command: 'screenshot', description: 'التقاط شاشة الحاسوب' },
    { command: 'files', description: 'تصفح ملفات الحاسوب' },
    { command: 'history', description: 'الشغالة وتطبيقات الإقلاع وآخر التشغيلات' },
    { command: 'stop', description: 'إيقاف تطبيق شغال' },
    { command: 'startup', description: 'إعدادات التشغيل مع إقلاع ويندوز' },
    { command: 'schedules', description: 'التشغيلات المجدولة' },
    { command: 'add', description: 'إضافة تطبيق جديد' },
    { command: 'edit', description: 'تعديل تطبيق' },
    { command: 'delete', description: 'حذف تطبيق' },
    { command: 'lang', description: 'تبديل اللغة (عربي/إنجليزي)' },
    { command: 'browser', description: 'فتح واجهة الويب على الحاسوب' },
  ];
  try {
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: cmdsEn }),
    });
    await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: cmdsAr, language_code: 'ar' }),
    });
    console.log('[bot] Commands menu (/) synced');
  } catch (e) { console.error('[bot] syncBotCommands error:', e?.message); }
}

function startTelegramBot(token, allowedChatId) {
  stopTelegramBot();
  if (!token) return;
  fetchBotInfo(token);
  syncBotCommands(token);

  _telegramPollActive = true;
  const myGen = ++_pollGeneration;
  let lastUpdateId = 0;

  reportConn('connecting');
  let welcomeSent = false; // send the welcome only after the first successful connection

  const poll = async () => {
    if (!_telegramPollActive) return;
    if (myGen !== _pollGeneration) return; // this poll generation was superseded
    let retryDelay = POLL_RETRY_ONLINE;
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 401) {
        // Permanent-ish failure: wrong token. Report once, keep a slow retry.
        retryDelay = POLL_RETRY_OFFLINE;
        reportConn('unauthorized');
        return;
      }
      if (res.status === 409) {
        // Another instance is polling with the same token.
        retryDelay = POLL_RETRY_OFFLINE;
        reportConn('conflict');
        return;
      }
      if (!res.ok) {
        retryDelay = POLL_RETRY_OFFLINE;
        reportConn('offline', `HTTP ${res.status}`);
        return;
      }

      const data = await res.json();
      if (!data.ok) {
        retryDelay = POLL_RETRY_OFFLINE;
        reportConn('offline', data.description || data.error_code || '');
        return;
      }

      // We reached Telegram successfully → we are online. This is the only
      // place "Connected successfully" is printed: once per connect/reconnect.
      if (connState !== 'online') {
        reportConn('online');
      }
      botInfo.is_running = true;
      retryDelay = POLL_RETRY_ONLINE;

      // Deferred welcome: only after a real, successful connection
      if (!welcomeSent && allowedChatId) {
        welcomeSent = true;
        try { await sendMsg(token, allowedChatId, T('🚀 *Terminal Telegram Runner* متصل وجاهز — ينتظر أوامرك!\n\nاختر تطبيقاً من القائمة أدناه:', '🚀 *Terminal Telegram Runner* connected and ready — awaiting your commands!\n\nChoose an app from the menu below:')); } catch {}
        try { await sendMainKeyboard(token, allowedChatId); } catch {}
        try { await sendAppMenu(token, allowedChatId); } catch {}
      }
      if (!data.result) return;

      for (const update of data.result) {
        if (update.update_id >= lastUpdateId) lastUpdateId = update.update_id;

        const msg = update.message || update.callback_query?.message;
        const chatId = msg?.chat?.id?.toString();
        if (allowedChatId && chatId !== allowedChatId) continue;

        // ── Incoming files (upload phone -> PC) ──────────────────────
        {
          const doc = update.message?.document;
          const photoArr = update.message?.photo;
          const video = update.message?.video;
          const audio = update.message?.audio;
          const incoming = doc || video || audio || (photoArr ? photoArr[photoArr.length - 1] : null);
          if (incoming?.file_id) {
            try {
              await sendMsg(token, chatId, '⬆️ جاري حفظ الملف على الحاسوب...');
              const fname = doc?.file_name || (video ? 'video.mp4' : audio ? 'audio.m4a' : `photo_${Date.now()}.jpg`);
              await saveIncomingDoc(token, chatId, incoming.file_id, fname);
            } catch (e) {
              await sendMsg(token, chatId, '❌ فشل الحفظ: ' + (e?.message || ''));
            }
            continue;
          }
        }

        // ── Text commands ──────────────────────────────────────────
        if (update.message?.text) {
          const text = update.message.text;

          if (text === '/start' || text.startsWith('/start ') || text.startsWith('/start@') || text === '/menu' || text.startsWith('/menu ') || text === '🚀 القائمة' || text === '🚀 Menu' || text === 'القائمة') {
            const cfg = loadConfig();
            const en = cfg.telegram_lang === 'en';
            // Build inline keyboard: app buttons in pairs
            const keyboard = [];
            for (let i = 0; i < cfg.apps.length; i += 2) {
              const row = [];
              row.push({ text: cfg.apps[i].name, callback_data: `run:${cfg.apps[i].id}` });
              if (cfg.apps[i + 1]) {
                row.push({ text: cfg.apps[i + 1].name, callback_data: `run:${cfg.apps[i + 1].id}` });
              }
              keyboard.push(row);
            }
            // Bottom row: action buttons (apps management only;
            // screenshot/files/language live in the reply keyboard)
            keyboard.push([
              { text: en ? '➕ Add' : '➕ إضافة أمر', callback_data: 'add_app' },
              { text: en ? '✏️ Edit' : '✏️ تعديل', callback_data: 'show_edit_menu' },
              { text: en ? '🗑 Delete' : '🗑 حذف', callback_data: 'show_delete_menu' },
            ]);
            keyboard.push([
              { text: en ? '🕘 History' : '🕘 السجل', callback_data: 'history_menu' },
              { text: en ? '⏹️ Stop' : '⏹️ إيقاف', callback_data: 'stop_menu' },
            ]);
            try {
              await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: chatId,
                  text: en ? `🚀 *Terminal Telegram Runner*\n\nYou have ${cfg.apps.length} app(s):\n` +
                    `${cfg.apps.map((a, i) => `${i + 1}. ${a.name} — ${a.commands.length} command(s)`).join('\n')}\n\n` +
                    `Choose an app to run or use the buttons below:`
                    : `🚀 *Terminal Telegram Runner*\n\n` +
                    `لديك ${cfg.apps.length} تطبيق${cfg.apps.length !== 1 ? 'ات' : ''}:\n` +
                    `${cfg.apps.map((a, i) => `${i + 1}. ${a.name} — ${a.commands.length} أمر`).join('\n')}\n\n` +
                    `اختر تطبيقاً للتشغيل أو استخدم الأزرار أدناه:`,
                  parse_mode: 'Markdown',
                  reply_markup: { inline_keyboard: keyboard },
                }),
              });
              await sendMainKeyboard(token, chatId);
            } catch (e) { console.error('[bot] /start sendMessage failed:', e?.message); }
            continue;
          }

          if (text === '/lang' || text.includes('🌐') || text.includes('اللغة') || text.includes('Language')) {
            convState.delete(chatId);
            const nl = toggleLang();
            await sendMsg(token, chatId, nl === 'en' ? '🌐 Language set to *English*.' : '🌐 تم التبديل إلى *العربية*.');
            await sendMainKeyboard(token, chatId);
            continue;
          }

          if (text === '/add' || text === '➕ إضافة أمر') {
            convState.set(chatId, { step: 'name' });
            await sendMsg(token, chatId, '📝 أرسل *اسم التطبيق* الجديد:');
            continue;
          }

          if (text === '/delete' || text === '🗑 حذف تطبيق') {
            convState.delete(chatId);
            await sendDeleteMenu(token, chatId);
            continue;
          }

          if (text === '/edit' || text === '✏️ تعديل') {
            convState.delete(chatId);
            await sendEditMenu(token, chatId);
            continue;
          }

          if (text === '/screenshot' || text === '📸' || text.includes('سكرين') || text.includes('Screenshot')) {
            convState.delete(chatId);
            try {
              await sendMsg(token, chatId, T('📸 جاري التقاط الشاشة...', '📸 Capturing screen...'));
              await sendScreenshot(token, chatId);
            } catch (e) {
              await sendMsg(token, chatId, T('❌ فشل السكرين شوت: ', '❌ Screenshot failed: ') + (e?.message || ''));
            }
            continue;
          }

          if (text === '/files' || text.includes('ملف') || text === '📁' || text.includes('Files')) {
            convState.delete(chatId);
            await sendFileMenu(token, chatId, os.homedir());
            continue;
          }

          if (text === '/schedules' || text.includes('مجدول') || text.includes('Schedule')) {
            convState.delete(chatId);
            await sendSchedules(token, chatId);
            continue;
          }

          if (text === '/history' || text.includes('السجل') || text.includes('History')) {
            convState.delete(chatId);
            await sendHistory(token, chatId);
            continue;
          }

          if (text === '/stop' || text === '⏹️ إيقاف' || text === '⏹️ Stop') {
            convState.delete(chatId);
            await sendStopMenu(token, chatId);
            continue;
          }

          if (text === '/startup' || text.includes('بدء التشغيل') || text.includes('Startup') || text.includes('إقلاع')) {
            convState.delete(chatId);
            await sendStartupMenu(token, chatId);
            continue;
          }

          if (text === '/browser' || text === '/ui' || text.includes('فتح الواجهة') || text.includes('Open UI') || text.includes('المتصفح')) {
            convState.delete(chatId);
            openBrowserUI();
            await sendMsg(token, chatId, T(
              '🌍 تم فتح الواجهة في المتصفح الافتراضي على الحاسوب:\nhttp://localhost:' + PORT,
              '🌍 Opened the Web UI in the default browser on the PC:\nhttp://localhost:' + PORT
            ));
            continue;
          }

          // Conversation: waiting for name or command
          const state = convState.get(chatId);
          if (state) {
            if (state.step === 'name') {
              state.name = text.trim();
              state.step = 'command';
              convState.set(chatId, state);
              await sendMsg(token, chatId, '📝 أرسل *الأمر (Command)* الذي تريد تشغيله:');
              continue;
            }
            if (state.step === 'command') {
              const cfg = loadConfig();
              const newApp = {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                name: state.name || 'Unnamed',
                commands: [text.trim()],
                startup: false,
              };
              cfg.apps.push(newApp);
              saveConfig(cfg);
              convState.delete(chatId);
              await sendMsg(token, chatId, `✅ تمت إضافة *${newApp.name}* بنجاح!\nالأمر: \`${newApp.commands[0]}\``);
              await sendAppMenu(token, chatId);
              continue;
            }
            // ── Edit conversation ──────────────────────────────
            if (state.step === 'edit_name') {
              const cfg = loadConfig();
              const app = cfg.apps.find(a => a.id === state.appId);
              if (!app) { convState.delete(chatId); continue; }
              if (text.trim() !== '/skip') {
                app.name = text.trim();
                saveConfig(cfg);
              }
              state.step = 'edit_commands';
              convState.set(chatId, state);
              const currentCmds = (app.commands || []).map(c => `\`${c}\``).join('\n');
              await sendMsg(token, chatId,
                `📋 *الأوامر الحالية:*\n${currentCmds}\n\n` +
                `أرسل الأوامر الجديدة، *كل أمر في سطر منفصل*:\n` +
                `أو أرسل \`/skip\` للإبقاء على الأوامر الحالية.`
              );
              continue;
            }
            if (state.step === 'edit_commands') {
              const cfg = loadConfig();
              const app = cfg.apps.find(a => a.id === state.appId);
              if (!app) { convState.delete(chatId); continue; }
              if (text.trim() !== '/skip') {
                app.commands = text.trim().split('\n').map(s => s.trim()).filter(Boolean);
                saveConfig(cfg);
              }
              convState.delete(chatId);
              const cmdList = (app.commands || []).map((c, i) => `  ${i + 1}\\. \`${escMd(c)}\``).join('\n');
              await sendMsg(token, chatId,
                `✏️ *تم تعديل:* ${escMd(app.name)}\n` +
                `📋 *الأوامر \\(${app.commands.length}\\):*\n${cmdList}`,
                { parse_mode: 'MarkdownV2' }
              );
              await sendAppMenu(token, chatId);
              continue;
            }
          }
        }

          // ── Callback query (button press) ──────────────────────────
        if (update.callback_query) {
          const cb = update.callback_query;
          const data_cb = cb.data || '';
          const cbChatId = cb.message.chat.id.toString();
          if (allowedChatId && cbChatId !== allowedChatId) continue;

          // Dedup: skip callback IDs already processed (belt-and-suspenders against double-execution)
          if (processedCbIds.has(cb.id)) {
            console.log(`[bot] Skipping duplicate callback: ${cb.id} (${data_cb})`);
            continue;
          }
          processedCbIds.add(cb.id);
          // Periodic cleanup to prevent unbounded growth
          if (processedCbIds.size > PROCESSED_CB_CLEANUP_THRESHOLD) {
            processedCbIds.clear();
            console.log('[bot] Cleared processedCbIds set (threshold reached)');
          }

          // IMPORTANT: check confirm_run: BEFORE run: because confirm_run: also starts with "run:"
          if (data_cb.startsWith('confirm_run:')) {
            const appId = data_cb.slice('confirm_run:'.length);
            const cfg = loadConfig();
            const app = cfg.apps.find(a => a.id === appId);
            if (app) {
              const cmds = app.commands || (app.command ? [app.command] : []);
              for (const cmd of cmds) {
                runCommand(app.name, cmd, app.shell || 'cmd');
              }
              logRun(app.name, 'telegram');
              await removeKeyboard(token, cbChatId, cb.message.message_id);
              await answerCallback(token, cb.id, `✅ تم تشغيل ${app.name}`);
              await sendMsg(token, cbChatId,
                `🔄 *${escMd(app.name)}* — Restarting / جاري إعادة التشغيل...\n` +
                `⚠️ سيتم إعادة تشغيل الحاسوب بعد 3 ثوانٍ / Restarting in 3 seconds.`
              );
            } else {
              await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
            }
            continue;
          }

          if (data_cb === 'cancel_run') {
            await answerCallback(token, cb.id, '❌ Cancelled / تم الإلغاء');
            await sendAppMenu(token, cbChatId);
            continue;
          }

          if (data_cb.startsWith('run:')) {
            const appId = data_cb.slice(4);
            const cfg = loadConfig();
            const app = cfg.apps.find(a => a.id === appId);
            if (app) {
              const cmds = app.commands || (app.command ? [app.command] : []);
              // Safety confirmation for shutdown/restart commands
              const isShutdown = cmds.some(c => {
                const low = c.toLowerCase();
                return low.includes('shutdown') || low.includes('stop-computer') || low.includes('restart-computer');
              });
              if (isShutdown) {
                const confirmKeyboard = [
                  [
                    { text: '✅ Confirm / تأكيد', callback_data: `confirm_run:${appId}` },
                    { text: '❌ Cancel / إلغاء', callback_data: 'cancel_run' },
                  ],
                ];
                  await answerCallback(token, cb.id, '⚠️ Confirm Restart / تأكيد إعادة التشغيل');
                try {
                  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      chat_id: cbChatId,
                      message_id: cb.message.message_id,
                      text: `⚠️ *Confirm Restart / تأكيد إعادة التشغيل*\n\n${escMd(app.name)}:\n${cmds.map(c => `\`${escMd(c)}\``).join('، ')}\n\nسيتم إعادة تشغيل الحاسوب فوراً\\! / This will restart immediately\\!`,
                      parse_mode: 'MarkdownV2',
                      reply_markup: { inline_keyboard: confirmKeyboard },
                    }),
                  });
                  } catch (e) { console.error('[bot] confirm editMessageText error:', e?.message); }
                continue;
              }
              for (const cmd of cmds) {
                runCommand(app.name, cmd, app.shell || 'cmd');
              }
              logRun(app.name, 'telegram');
              const cmdList = cmds.map((c, i) => `  ${i + 1}\\. \`${escMd(c)}\``).join('\n');
              await answerCallback(token, cb.id, `✅ تشغيل ${app.name}`);
              await sendMsg(token, cbChatId,
                `✅ *تم تشغيل:* ${escMd(app.name)}\n` +
                `📋 *الأوامر \\(${cmds.length}\\):*\n${cmdList}\n\n` +
                `🖥️ تم فتح ${cmds.length} نافذة terminal\n` +
                T(`🚀 التشغيل التلقائي عند الإقلاع: ${app.startup ? 'مفعّل' : 'معطّل'}`,
                  `🚀 Auto start on boot: ${app.startup ? 'ON' : 'OFF'}`),
                { reply_to_message_id: cb.message.message_id, parse_mode: 'MarkdownV2' }
              );
            } else {
              await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
            }
          }

          if (data_cb === 'add_app') {
            convState.set(cbChatId, { step: 'name' });
            await answerCallback(token, cb.id, '📝 أرسل اسم التطبيق');
            await sendMsg(token, cbChatId, '📝 أرسل *اسم التطبيق* الجديد:');
            continue;
          }

          // ── Delete flow ─────────────────────────────────────
          if (data_cb.startsWith('delete:')) {
            const appId = data_cb.slice('delete:'.length);
            const cfg = loadConfig();
            const app = cfg.apps.find(a => a.id === appId);
            if (!app) {
              await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
              continue;
            }
            await answerCallback(token, cb.id, '🗑 تأكيد الحذف');
            // Edit the message to show confirmation
            const confirmKeyboard = [
              [
                { text: '✅ نعم، احذف', callback_data: `confirm_delete:${appId}` },
                { text: '❌ إلغاء', callback_data: 'cancel_delete' },
              ],
            ];
            try {
              await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: cbChatId,
                  message_id: cb.message.message_id,
                  text: `🗑 *تأكيد حذف التطبيق*\n\nهل تريد حذف *${escMd(app.name)}*؟\nالأوامر: ${(app.commands || []).map(c => `\`${escMd(c)}\``).join('، ')}`,
                  parse_mode: 'MarkdownV2',
                  reply_markup: { inline_keyboard: confirmKeyboard },
                }),
              });
            } catch {}
          }

          if (data_cb.startsWith('confirm_delete:')) {
            const appId = data_cb.slice('confirm_delete:'.length);
            const cfg = loadConfig();
            const app = cfg.apps.find(a => a.id === appId);
            const appName = app ? app.name : 'غير معروف';
            cfg.apps = cfg.apps.filter(a => a.id !== appId);
            saveConfig(cfg);
            await answerCallback(token, cb.id, `✅ تم حذف ${appName}`);
            // Edit confirmation message to show deleted
            try {
              await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  chat_id: cbChatId,
                  message_id: cb.message.message_id,
                  text: `✅ *تم حذف التطبيق*\n\n"${escMd(appName)}" — تمت إزالته بنجاح\\.`,
                  parse_mode: 'MarkdownV2',
                  reply_markup: {},
                }),
              });
            } catch {}
            await sendAppMenu(token, cbChatId);
            continue;
          }

          if (data_cb === 'cancel_delete') {
            await answerCallback(token, cb.id, '❌ تم الإلغاء');
            await sendAppMenu(token, cbChatId);
            continue;
          }

          // ── Navigation ────────────────────────────────────────
          if (data_cb === 'show_delete_menu') {
            await answerCallback(token, cb.id, '🗑 قائمة الحذف');
            await sendDeleteMenu(token, cbChatId);
            continue;
          }

          if (data_cb === 'show_edit_menu') {
            await answerCallback(token, cb.id, '✏️ قائمة التعديل');
            await sendEditMenu(token, cbChatId);
            continue;
          }

          if (data_cb.startsWith('edit:')) {
            const appId = data_cb.slice('edit:'.length);
            const cfg = loadConfig();
            const app = cfg.apps.find(a => a.id === appId);
            if (!app) {
              await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
              continue;
            }
            await answerCallback(token, cb.id, `✏️ تعديل ${app.name}`);
            // Start edit conversation
            convState.set(cbChatId, { step: 'edit_name', appId });
            const cmdList = (app.commands || []).map((c, i) => `  ${i + 1}\\. \`${escMd(c)}\``).join('\n');
            await sendMsg(token, cbChatId,
              `✏️ *تعديل:* ${escMd(app.name)}\n` +
              `📋 *الأوامر الحالية:*\n${cmdList}\n\n` +
              `أرسل *الاسم الجديد*:\n` +
              `أو أرسل \`/skip\` للإبقاء على الاسم الحالي.`,
              { parse_mode: 'MarkdownV2' }
            );
            continue;
          }

          if (data_cb === 'back_to_menu') {
            await answerCallback(token, cb.id, '🔙 الرجوع للقائمة');
            await sendAppMenu(token, cbChatId);
            continue;
          }

          if (data_cb === 'stop_menu') {
            await answerCallback(token, cb.id, '⏹️ قائمة الإيقاف');
            await sendStopMenu(token, cbChatId);
            continue;
          }

          if (data_cb === 'history_menu') {
            await answerCallback(token, cb.id, T('🕘 السجل والشغالة', '🕘 History & Running'));
            await sendHistory(token, cbChatId);
            continue;
          }

          if (data_cb.startsWith('hstop:')) {
            try {
              const appId = data_cb.slice('hstop:'.length);
              const cfg = loadConfig();
              const app = cfg.apps.find(a => a.id === appId);
              if (app) {
                console.log(`[bot] Request to stop from history: ${app.name}`);
                stopCommand(app.name);
                logRun(app.name, 'stop-telegram');
                await answerCallback(token, cb.id, `⏹️ ${T('تم إيقاف', 'Stopped')} ${app.name}`);
              } else {
                await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
              }
            } catch (e) {
              console.error('[bot] Error in hstop handler:', e);
              try { await answerCallback(token, cb.id, '❌ حدث خطأ'); } catch {}
            }
            await sendHistory(token, cbChatId);
            continue;
          }

          if (data_cb === 'startup_menu') {
            await answerCallback(token, cb.id, T('🔥 بدء التشغيل', '🔥 Startup'));
            await sendStartupMenu(token, cbChatId);
            continue;
          }

          if (data_cb.startsWith('startup_toggle:')) {
            const appId = data_cb.slice('startup_toggle:'.length);
            const cfg = loadConfig();
            const app = cfg.apps.find(a => a.id === appId);
            if (!app) {
              await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
              continue;
            }
            app.startup = !app.startup;
            saveConfig(cfg);
            await answerCallback(token, cb.id, app.startup
              ? T(`✅ ${app.name}: سيشتغل عند الإقلاع`, `✅ ${app.name}: will run on boot`)
              : T(`⚪ ${app.name}: أُلغي التشغيل التلقائي`, `⚪ ${app.name}: auto-run disabled`));
            await sendStartupMenu(token, cbChatId);
            continue;
          }

          if (data_cb === 'startup_server_toggle') {
            const next = !isStartupEnabled();
            toggleStartup(next);
            await answerCallback(token, cb.id, next
              ? T('🖥 السيرفر سيشتغل مع ويندوز', '🖥 Server will start with Windows')
              : T('🖥 أُوقف بدء السيرفر مع ويندوز', '🖥 Server auto-start disabled'));
            await sendStartupMenu(token, cbChatId);
            continue;
          }

          if (data_cb === 'open_browser') {
            openBrowserUI();
            await answerCallback(token, cb.id, T('🌍 فتح الواجهة', '🌍 Opening UI'));
            await sendMsg(token, cbChatId, T(
              '🌍 تم فتح الواجهة في المتصفح الافتراضي على الحاسوب:\nhttp://localhost:' + PORT,
              '🌍 Opened the Web UI in the default browser on the PC:\nhttp://localhost:' + PORT
            ));
            continue;
          }

          if (data_cb === 'screenshot') {
            await answerCallback(token, cb.id, '📸 جاري التقاط الشاشة...');
            try {
              await sendScreenshot(token, cbChatId);
            } catch (e) {
              await sendMsg(token, cbChatId, '❌ فشل السكرين شوت: ' + (e?.message || ''));
            }
            continue;
          }

          if (data_cb === 'files_menu') {
            await answerCallback(token, cb.id, '📁 الملفات');
            await sendFileMenu(token, cbChatId, os.homedir());
            continue;
          }

          if (data_cb.startsWith('fm:')) {
            await answerCallback(token, cb.id, '📁 فتح مجلد...');
            await sendFileMenu(token, cbChatId, data_cb.slice(3));
            continue;
          }

          if (data_cb.startsWith('fdown:')) {
            await answerCallback(token, cb.id, '⬇️ جاري الإرسال...');
            try {
              await sendDocToChat(token, cbChatId, data_cb.slice(6));
            } catch (e) {
              await sendMsg(token, cbChatId, '❌ فشل الإرسال: ' + (e?.message || ''));
            }
            continue;
          }

          if (data_cb === 'toggle_lang') {
            const nl = toggleLang();
            await answerCallback(token, cb.id, nl === 'en' ? '🌐 English' : '🌐 العربية');
            await sendMsg(token, cbChatId, nl === 'en' ? '🌐 Language set to *English*.' : '🌐 تم التبديل إلى *العربية*.');
            await sendMainKeyboard(token, cbChatId);
            await sendAppMenu(token, cbChatId);
            continue;
          }

          if (data_cb.startsWith('sch_del:')) {
            const sid = data_cb.slice('sch_del:'.length);
            cancelSchedule(sid);
            await answerCallback(token, cb.id, T('⏰ أُلغيت الجدولة', '⏰ Schedule cancelled'));
            await sendSchedules(token, cbChatId);
            continue;
          }

          if (data_cb.startsWith('stop_app:')) {
            // Wrap in try/catch so no error escapes silently
            try {
              const appId = data_cb.slice('stop_app:'.length);
              const cfg = loadConfig();
              const app = cfg.apps.find(a => a.id === appId);
              if (app) {
                console.log(`[bot] Request to stop: ${app.name}`);
                // Remove keyboard from the stop menu message
                await removeKeyboard(token, cbChatId, cb.message.message_id);
                stopCommand(app.name);
                await answerCallback(token, cb.id, `⏹️ تم إيقاف ${app.name}`);
                await sendMsg(token, cbChatId, `⏹️ تم إيقاف "${app.name}" بنجاح.`);
              } else {
                await answerCallback(token, cb.id, '❌ التطبيق غير موجود');
              }
            } catch (e) {
              console.error('[bot] Error in stop_app handler:', e);
              try { await answerCallback(token, cb.id, '❌ حدث خطأ'); } catch {}
            }
            continue;
          }
        }
      }
    } catch (e) {
      // Lost connection (DNS / timeout / ECONNRESET / no internet).
      // Report only a state change; never repeat the same line.
      retryDelay = POLL_RETRY_OFFLINE;
      const reason = e?.name === 'AbortError' ? 'timeout' : (e?.code || e?.message || 'network');
      reportConn('offline', reason);
      botInfo.is_running = false;
    } finally {
      if (_telegramPollActive) {
        telegramInterval = setTimeout(poll, retryDelay);
      }
    }
  };

  telegramInterval = setTimeout(poll, 1000);
}

function stopTelegramBot() {
  _telegramPollActive = false;
  if (telegramInterval) {
    clearTimeout(telegramInterval);
    telegramInterval = null;
  }
  botInfo = { name: '', username: '', is_running: false };
}

async function sendMsg(token, chatId, text, extra = {}) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        ...extra,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[bot] sendMsg failed (${res.status}): ${errText.slice(0, 200)}`);
    }
  } catch (e) { console.error('[bot] sendMsg error:', e?.message); }
}

async function sendAppMenu(token, chatId) {
  const cfg = loadConfig();
  const en = cfg.telegram_lang === 'en';

  // Build inline keyboard: app buttons in pairs
  const keyboard = [];
  for (let i = 0; i < cfg.apps.length; i += 2) {
    const row = [];
    row.push({ text: cfg.apps[i].name, callback_data: `run:${cfg.apps[i].id}` });
    if (cfg.apps[i + 1]) {
      row.push({ text: cfg.apps[i + 1].name, callback_data: `run:${cfg.apps[i + 1].id}` });
    }
    keyboard.push(row);
  }
  // Bottom row: action buttons (apps management only;
  // screenshot/files/language live in the reply keyboard)
  keyboard.push([
    { text: en ? '➕ Add' : '➕ إضافة أمر', callback_data: 'add_app' },
    { text: en ? '✏️ Edit' : '✏️ تعديل', callback_data: 'show_edit_menu' },
    { text: en ? '🗑 Delete' : '🗑 حذف', callback_data: 'show_delete_menu' },
  ]);
  // History + Stop row
  keyboard.push([
    { text: en ? '🕘 History' : '🕘 السجل', callback_data: 'history_menu' },
    { text: en ? '⏹️ Stop' : '⏹️ إيقاف', callback_data: 'stop_menu' },
  ]);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: en ? `🚀 *Terminal Telegram Runner \\- Menu*\n\nYou have ${cfg.apps.length} app\\(s\\):\n` +
          `${cfg.apps.map((a, i) => `${i + 1}\\. ${escMd(a.name)} — ${a.commands.length} command\\(s\\)`).join('\n')}\n\n` +
          `Choose an app to run or use the buttons below:`
        : `🚀 *Terminal Telegram Runner \\- القائمة*\n\n` +
          `لديك ${cfg.apps.length} تطبيق${cfg.apps.length !== 1 ? 'ات' : ''}:\n` +
          `${cfg.apps.map((a, i) => `${i + 1}\\. ${escMd(a.name)} — ${a.commands.length} أمر`).join('\n')}\n\n` +
          `اختر تطبيقاً للتشغيل أو استخدم الأزرار أدناه:`,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) { console.error('[bot] sendAppMenu error:', e?.message); }
}

// ─── Startup menu (per-app auto-run on Windows boot) + open Web UI ───
function openBrowserUI() {
  const url = `http://localhost:${PORT}`;
  exec(`cmd /c start "" "${url}"`, { windowsHide: true }, (err) => {
    if (err) console.error('[browser] open failed:', err.message);
    else console.log(`[browser] Opened ${url} in default browser`);
  });
}

async function sendStartupMenu(token, chatId) {
  const cfg = loadConfig();
  const en = cfg.telegram_lang === 'en';
  const serverStartup = isStartupEnabled();

  // One app per row: tap to toggle auto-run ONLY (never launches the app).
  // Explicit toggle labels so rows can't be mistaken for "run" buttons.
  const keyboard = cfg.apps.map(a => [
    {
      text: en
        ? `${a.startup ? '✅ Auto-run ON' : '⚪ Auto-run OFF'} | ${a.name}`
        : `${a.startup ? '✅ تشغيل تلقائي' : '⚪ تشغيل تلقائي'} | ${a.name}`,
      callback_data: `startup_toggle:${a.id}`,
    },
  ]);
  // Server-level auto-start toggle (required for per-app boot run to work)
  keyboard.push([
    {
      text: en
        ? (serverStartup ? '🖥 Server auto-start: ON — tap to disable' : '🖥 Server auto-start: OFF — tap to enable')
        : (serverStartup ? '🖥 بدء السيرفر مع ويندوز: مفعّل — اضغط للتعطيل' : '🖥 بدء السيرفر مع ويندوز: معطّل — اضغط للتفعيل'),
      callback_data: 'startup_server_toggle',
    },
  ]);
  keyboard.push([{ text: en ? '🔙 Back' : '🔙 رجوع', callback_data: 'back_to_menu' }]);

  const text = en
    ? `🔥 *Startup — run on Windows boot*\n\n` +
      `Tap an app to toggle auto-run. ✅ means it will run automatically when the server starts.\n` +
      `Tap again to cancel.\n` +
      `This menu only toggles auto-run — it never launches apps. To launch, use the main menu.\n\n` +
      `Note: per-app boot run only works if the server itself starts with Windows — use the Server auto-start button above. ` +
      `Server is currently *${serverStartup ? 'ON' : 'OFF'}*.`
    : `🔥 *بدء التشغيل — التشغيل عند إقلاع ويندوز*\n\n` +
      `اضغط على أمر لتفعيل / إلغاء التشغيل التلقائي. ✅ يعني سيشتغل تلقائيا عند بدء السيرفر.\n` +
      `اضغط مجددا للإلغاء.\n` +
      `هذه القائمة للتبديل فقط — لا تشغّل التطبيقات. للتشغيل استخدم القائمة الرئيسية.\n\n` +
      `ملاحظة: التشغيل عند إقلاع ويندوز يعمل فقط إذا كان السيرفر نفسه يشتغل مع ويندوز — استخدم زر بدء السيرفر مع ويندوز أعلاه. ` +
      `السيرفر حاليا *${serverStartup ? 'مفعل' : 'معطل'}*.`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
    if (!r.ok) {
      // Fallback: resend as plain text (no parse_mode) so the menu always arrives
      const t = await r.text().catch(() => '');
      console.error(`[bot] sendStartupMenu markdown failed (${r.status}): ${t.slice(0, 200)} — retrying plain`);
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text.replace(/\*/g, ''),
          reply_markup: { inline_keyboard: keyboard },
        }),
      });
    }
  } catch (e) { console.error('[bot] sendStartupMenu error:', e?.message); }
}

async function sendStopMenu(token, chatId) {
  const cfg = loadConfig();
  if (cfg.apps.length === 0) {
    await sendMsg(token, chatId, '📭 لا توجد تطبيقات لإيقافها.');
    return;
  }

  // One app per row with stop button
  const keyboard = cfg.apps.map(a => [
    { text: `⏹️ ${a.name}`, callback_data: `stop_app:${a.id}` },
  ]);
  // Back button
  keyboard.push([{ text: '🔙 رجوع', callback_data: 'back_to_menu' }]);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⏹️ *إيقاف تطبيق*\n\nاختر التطبيق الذي تريد إيقافه:`,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) { console.error('[bot] sendStopMenu error:', e?.message); }
}

async function sendDeleteMenu(token, chatId) {
  const cfg = loadConfig();
  if (cfg.apps.length === 0) {
    await sendMsg(token, chatId, '📭 لا توجد تطبيقات للحذف.');
    return;
  }

  // One app per row with delete button
  const keyboard = cfg.apps.map(a => [
    { text: `🗑 ${a.name}`, callback_data: `delete:${a.id}` },
  ]);
  // Back button
  keyboard.push([{ text: '🔙 رجوع', callback_data: 'back_to_menu' }]);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🗑 *حذف تطبيق*\n\nاختر التطبيق الذي تريد حذفه:`,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) { console.error('[bot] sendDeleteMenu error:', e?.message); }
}

async function sendEditMenu(token, chatId) {
  const cfg = loadConfig();
  if (cfg.apps.length === 0) {
    await sendMsg(token, chatId, '📭 لا توجد تطبيقات لتعديلها.');
    return;
  }

  // One app per row with edit button
  const keyboard = cfg.apps.map(a => [
    { text: `✏️ ${a.name}`, callback_data: `edit:${a.id}` },
  ]);
  // Back button
  keyboard.push([{ text: '🔙 رجوع', callback_data: 'back_to_menu' }]);

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✏️ *تعديل تطبيق*\n\nاختر التطبيق الذي تريد تعديله:`,
        parse_mode: 'MarkdownV2',
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
  } catch (e) { console.error('[bot] sendEditMenu error:', e?.message); }
}

// Escape text for MarkdownV2 (Telegram requires escaping reserved chars)
function escMd(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function answerCallback(token, cbId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: cbId, text, show_alert: false }),
    });
  } catch (e) { console.error('[bot] answerCallback error:', e?.message); }
}

async function removeKeyboard(token, chatId, messageId) {
  try {
    await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {},
      }),
    });
  } catch (e) { console.error('[bot] removeKeyboard error:', e?.message); }
}

// ─── HTTP Router ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // API routes
  if (pathname === '/api/apps' && req.method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, cfg.apps);
  }

  if (pathname === '/api/apps' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cfg = loadConfig();
      const newApp = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name: body.name || 'Unnamed',
        commands: body.commands || (body.command ? [body.command] : []),
        startup: body.startup ?? false,
        shell: body.shell || 'cmd',
      };
      cfg.apps.push(newApp);
      saveConfig(cfg);
      return json(res, 200, newApp);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/apps/') && req.method === 'DELETE') {
    const id = pathname.split('/')[3];
    const cfg = loadConfig();
    const app = cfg.apps.find(a => a.id === id);
    // Stop any running processes for this app before deletion
    if (app) {
      stopCommand(app.name);
    }
    cfg.apps = cfg.apps.filter(a => a.id !== id);
    saveConfig(cfg);
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/apps/') && req.method === 'PUT') {
    try {
      const id = pathname.split('/')[3];
      const body = await readBody(req);
      const cfg = loadConfig();
      const idx = cfg.apps.findIndex(a => a.id === id);
      if (idx === -1) return json(res, 404, { error: 'App not found' });
      if (body.name !== undefined) cfg.apps[idx].name = body.name;
      if (body.commands !== undefined) cfg.apps[idx].commands = body.commands;
      if (body.command !== undefined) cfg.apps[idx].commands = [body.command];
      if (body.startup !== undefined) cfg.apps[idx].startup = body.startup;
      if (body.shell !== undefined) cfg.apps[idx].shell = body.shell;
      saveConfig(cfg);
      return json(res, 200, cfg.apps[idx]);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // Toggle startup for a specific app
  if (pathname.startsWith('/api/apps/') && pathname.endsWith('/startup') && req.method === 'POST') {
    try {
      const id = pathname.split('/')[3];
      const body = await readBody(req);
      const cfg = loadConfig();
      const app = cfg.apps.find(a => a.id === id);
      if (!app) return json(res, 404, { error: 'App not found' });
      app.startup = !!body.enabled;
      saveConfig(cfg);
      return json(res, 200, { ok: true, enabled: app.startup });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/apps/') && pathname.endsWith('/run') && req.method === 'POST') {
    const id = pathname.split('/')[3];
    const cfg = loadConfig();
    const app = cfg.apps.find(a => a.id === id);
    if (!app) return json(res, 404, { error: 'App not found' });
    const cmds = app.commands || (app.command ? [app.command] : []);
    for (const cmd of cmds) {
      runCommand(app.name, cmd, app.shell || 'cmd');
    }
    logRun(app.name, 'web');
    return json(res, 200, { ok: true, name: app.name, count: cmds.length });
  }

  // ─── Running processes (live): tracked PIDs + startup flags ──────
  function pidAlive(pid) {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return false;
    try {
      const out = execSync(`tasklist /FI "PID eq ${n}" /NH /FO CSV`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString();
      return out.includes(`"${n}"`);
    } catch { return false; }
  }
  function liveRunning() {
    // Prune dead PIDs, return [{ name, pids[] }]
    const out = [];
    for (const [name, pids] of runningProcesses) {
      const alive = [...new Set((pids || []).map(Number))].filter(pidAlive);
      if (alive.length) {
        runningProcesses.set(name, alive);
        out.push({ name, pids: alive });
      } else {
        runningProcesses.delete(name);
      }
    }
    return out;
  }

  if (pathname === '/api/running' && req.method === 'GET') {
    const cfg = loadConfig();
    const running = liveRunning();
    const runningNames = new Set(running.map(r => r.name));
    const startupApps = (cfg.apps || []).filter(a => a.startup).map(a => ({
      id: a.id, name: a.name, running: runningNames.has(a.name),
    }));
    return json(res, 200, { running, startupApps, serverStartup: isStartupEnabled() });
  }

  if (pathname === '/api/running/stop' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const names = Array.isArray(body.names) ? body.names.map(String) : (body.name ? [String(body.name)] : []);
      if (!names.length) return json(res, 400, { error: 'Missing name' });
      const stopped = [];
      for (const name of names) {
        stopCommand(name);
        runningProcesses.delete(name);
        stopped.push(name);
      }
      logRun(stopped.join(', '), 'stop-web');
      return json(res, 200, { ok: true, stopped });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, {
      telegram_token: cfg.telegram_token ? cfg.telegram_token.substring(0, 5) + '...' : '',
      telegram_chat_id: cfg.telegram_chat_id || '',
      has_token: !!cfg.telegram_token,
      download_dir: cfg.download_dir || '',
      telegram_lang: cfg.telegram_lang || 'ar',
    });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cfg = loadConfig();
      cfg.telegram_token = body.telegram_token ?? cfg.telegram_token;
      cfg.telegram_chat_id = body.telegram_chat_id ?? cfg.telegram_chat_id;
      if (body.download_dir !== undefined && String(body.download_dir).trim()) {
        const dd = path.resolve(String(body.download_dir).trim());
        fs.mkdirSync(dd, { recursive: true });
        cfg.download_dir = dd;
      }
      if (body.telegram_lang === 'ar' || body.telegram_lang === 'en') {
        cfg.telegram_lang = body.telegram_lang;
      }
      saveConfig(cfg);
      // Restart bot with new credentials
      startTelegramBot(cfg.telegram_token, cfg.telegram_chat_id);
      return json(res, 200, { ok: true, download_dir: cfg.download_dir, telegram_lang: cfg.telegram_lang });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // Bot status endpoint
  if (pathname === '/api/bot/status' && req.method === 'GET') {
    const cfg = loadConfig();
    return json(res, 200, {
      ...botInfo,
      has_token: !!cfg.telegram_token,
      token_preview: cfg.telegram_token ? cfg.telegram_token.substring(0, 5) + '...' : '',
      chat_id: cfg.telegram_chat_id || '',
    });
  }

  // Send message via bot
  if (pathname === '/api/bot/send' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cfg = loadConfig();
      if (!cfg.telegram_token) return json(res, 400, { error: 'No bot token' });
      const targetChat = body.chat_id || cfg.telegram_chat_id;
      if (!targetChat) return json(res, 400, { error: 'No target chat ID' });
      await sendMsg(cfg.telegram_token, targetChat, body.text || '');
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // Send file via bot (PC -> phone). Max 45MB (Telegram bot limit ~50MB)
  const TG_FILE_MAX = 45 * 1024 * 1024;
  if (pathname === '/api/bot/send-file' && req.method === 'POST') {
    let sendId = null;
    let ctrl = null;
    try {
      const body = await readBody(req);
      sendId = body.sendId ? String(body.sendId) : null;
      const cfg = loadConfig();
      if (!cfg.telegram_token) return json(res, 400, { error: 'No bot token' });
      const targetChat = body.chat_id || cfg.telegram_chat_id;
      if (!targetChat) return json(res, 400, { error: 'No target chat ID' });
      let buf, filename;
      if (body.path) {
        const fp = path.resolve(String(body.path));
        const st = fs.statSync(fp);
        if (st.isDirectory()) return json(res, 400, { error: 'Path is a directory' });
        if (st.size > TG_FILE_MAX) return json(res, 413, { error: `File too large (${Math.round(st.size / 1048576)}MB). Max 45MB via Telegram.` });
        buf = fs.readFileSync(fp);
        filename = path.basename(fp);
      } else {
        filename = path.basename(body.filename || 'file.bin');
        if (!body.contentBase64) return json(res, 400, { error: 'Missing contentBase64 or path' });
        buf = Buffer.from(body.contentBase64, 'base64');
        if (buf.length > TG_FILE_MAX) return json(res, 413, { error: `File too large (${Math.round(buf.length / 1048576)}MB). Max 45MB via Telegram.` });
      }
      ctrl = new AbortController();
      if (sendId) pendingSends.set(sendId, ctrl);
      const form = new FormData();
      form.append('chat_id', String(targetChat));
      if (body.caption) form.append('caption', String(body.caption).slice(0, 1000));
      form.append('document', new Blob([buf], { type: 'application/octet-stream' }), filename);
      const tg = await fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendDocument`, { method: 'POST', body: form, signal: ctrl.signal });
      if (!tg.ok) {
        const t = await tg.text().catch(() => '');
        return json(res, 502, { error: `Telegram rejected (${tg.status}): ${t.slice(0, 200)}` });
      }
      return json(res, 200, { ok: true, filename, size: buf.length });
    } catch (e) {
      if (e?.name === 'AbortError') return json(res, 499, { error: 'Cancelled by user / تم الإيقاف' });
      try { if (!res.headersSent) return json(res, 400, { error: 'Send-file failed: ' + (e?.message || '') }); } catch {}
    } finally {
      if (sendId) pendingSends.delete(sendId);
    }
    return;
  }

  // Cancel an in-flight send (aborts the server->Telegram forward)
  if (pathname === '/api/bot/send-file/cancel' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const id = body.sendId ? String(body.sendId) : null;
      const c = id ? pendingSends.get(id) : null;
      if (c) {
        try { c.abort(); } catch {}
        pendingSends.delete(id);
        return json(res, 200, { ok: true, cancelled: true });
      }
      return json(res, 200, { ok: true, cancelled: false });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // Startup with Windows
  if (pathname === '/api/startup' && req.method === 'GET') {
    return json(res, 200, {
      enabled: isStartupEnabled(),
      shortcutPath: getStartupShortcutPath(),
    });
  }

  if (pathname === '/api/startup' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      toggleStartup(!!body.enabled);
      return json(res, 200, { enabled: isStartupEnabled() });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ─── File Manager (mini) ──────────────────────────────────────
  function fmResolve(p) {
    if (!p) return os.homedir();
    return path.resolve(p);
  }

  // List available drives (Windows) for the folder picker
  if (pathname === '/api/files/drives' && req.method === 'GET') {
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) drives.push(d); } catch {}
    }
    return json(res, 200, { drives, home: os.homedir() });
  }

  // List only sub-directories (for the folder picker)
  if (pathname === '/api/files/dirs' && req.method === 'GET') {
    try {
      const dir = fmResolve(url.searchParams.get('path'));
      const names = fs.readdirSync(dir);
      const dirs = names.filter(n => {
        try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch { return false; }
      }).sort((a, b) => a.localeCompare(b)).slice(0, 300)
        .map(n => ({ name: n, path: path.join(dir, n) }));
      return json(res, 200, { cwd: dir, parent: path.dirname(dir), dirs });
    } catch (e) {
      return json(res, 400, { error: 'List failed: ' + (e?.message || '') });
    }
  }

  // Native Windows folder dialog. The server itself runs hidden, and a
  // hidden process cannot show UI — so the picker is launched in a VISIBLE
  // console window (via `start`) which gives the dialog a proper UI
  // context. Result comes back through a temp file; we poll for it
  // WITHOUT blocking the event loop so the bot keeps working.
  if (pathname === '/api/files/pick-folder' && req.method === 'POST') {
    const tag = Date.now().toString(36);
    const tmpFile = path.join(os.tmpdir(), `tr_pick_${tag}.ps1`);
    const resFile = path.join(os.tmpdir(), `tr_pick_${tag}.txt`);
    try {
      const lines = [
        `Add-Type -AssemblyName System.Windows.Forms`,
        `$d = New-Object System.Windows.Forms.FolderBrowserDialog`,
        `$d.Description = 'Select Terminal Runner save folder'`,
        `$d.ShowNewFolderButton = $true`,
        `$d.TopMost = $true`,
        `$r = if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath } else { 'CANCELLED' }`,
        `[System.IO.File]::WriteAllText('${resFile}', $r)`,
      ];
      fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
      try { fs.unlinkSync(resFile); } catch {}
      const child = spawn('cmd.exe',
        ['/c', 'start', 'TerminalRunner-Folder', 'powershell', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
        { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && child.unref) child.unref();
      const deadline = Date.now() + 180000;
      let picked = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 500));
        try {
          if (fs.existsSync(resFile)) {
            picked = fs.readFileSync(resFile, 'utf8').trim().split(/\r?\n/).pop().trim();
            break;
          }
        } catch {}
      }
      try { fs.unlinkSync(tmpFile); } catch {}
      try { fs.unlinkSync(resFile); } catch {}
      if (!picked) return json(res, 408, { error: 'Timed out waiting for folder choice' });
      if (picked === 'CANCELLED') return json(res, 200, { ok: true, cancelled: true });
      return json(res, 200, { ok: true, path: picked });
    } catch (e) {
      try { fs.unlinkSync(tmpFile); } catch {}
      return json(res, 500, { error: 'Folder dialog failed: ' + (e?.message || '') });
    }
  }

  if (pathname === '/api/files' && req.method === 'GET') {
    try {
      const dir = fmResolve(url.searchParams.get('path'));
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return json(res, 400, { error: 'Not a directory' });
      const names = fs.readdirSync(dir);
      const entries = names.slice(0, 500).map(n => {
        const fp = path.join(dir, n);
        try {
          const s = fs.statSync(fp);
          return { name: n, path: fp, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
        } catch { return { name: n, path: fp, isDir: false, size: 0, mtime: 0 }; }
      }).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
      return json(res, 200, { cwd: dir, parent: path.dirname(dir), home: os.homedir(), entries });
    } catch (e) {
      return json(res, 400, { error: 'List failed: ' + (e?.message || '') });
    }
  }

  if (pathname === '/api/files/download' && req.method === 'GET') {
    try {
      const fp = fmResolve(url.searchParams.get('path'));
      const st = fs.statSync(fp);
      if (st.isDirectory()) return json(res, 400, { error: 'Is a directory' });
      if (st.size > 100 * 1024 * 1024) return json(res, 413, { error: 'File too large (100MB max)' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': st.size,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(fp))}"`,
      });
      fs.createReadStream(fp).pipe(res);
      return;
    } catch (e) {
      return json(res, 404, { error: 'Download failed: ' + (e?.message || '') });
    }
  }

  if (pathname === '/api/files/upload' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const dir = fmResolve(body.dir);
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return json(res, 400, { error: 'Target not a directory' });
      const safeName = path.basename(body.filename || 'upload.bin');
      if (!body.contentBase64) return json(res, 400, { error: 'Missing contentBase64' });
      if (body.contentBase64.length > 35 * 1024 * 1024) return json(res, 413, { error: 'File too large (25MB max via web)' });
      const buf = Buffer.from(body.contentBase64, 'base64');
      fs.writeFileSync(path.join(dir, safeName), buf);
      return json(res, 200, { ok: true, path: path.join(dir, safeName), size: buf.length });
    } catch (e) {
      return json(res, 400, { error: 'Upload failed: ' + (e?.message || '') });
    }
  }

  // Screenshot: capture primary screen and return PNG
  if (pathname === '/api/screenshot' && req.method === 'GET') {
    try {
      const file = takeScreenshot();
      const data = fs.readFileSync(file);
      try { fs.unlinkSync(file); } catch {}
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': data.length });
      res.end(data);
      return;
    } catch (e) {
      return json(res, 500, { error: 'Screenshot failed: ' + (e?.message || '') });
    }
  }

  // ─── Schedules ────────────────────────────────────────────────
  if (pathname === '/api/schedules' && req.method === 'GET') {
    const cfg = loadConfig();
    const now = Date.now();
    return json(res, 200, (cfg.schedules || []).map(s => ({
      ...s, remainingSec: Math.max(0, Math.round((s.runAt - now) / 1000)),
    })));
  }

  if (pathname === '/api/schedules' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const cfg = loadConfig();
      const app = cfg.apps.find(a => a.id === body.appId);
      if (!app) return json(res, 404, { error: 'App not found' });
      let runAt = body.runAt;
      if (!runAt && body.afterSeconds) runAt = Date.now() + Math.max(10, Number(body.afterSeconds)) * 1000;
      if (!runAt || runAt <= Date.now()) return json(res, 400, { error: 'runAt must be in the future (or afterSeconds >= 10)' });
      const s = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        appId: app.id, appName: app.name, runAt, createdAt: Date.now(),
      };
      cfg.schedules = cfg.schedules || [];
      cfg.schedules.push(s);
      saveConfig(cfg);
      armSchedule(s);
      return json(res, 200, s);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (pathname.startsWith('/api/schedules/') && req.method === 'DELETE') {
    const id = pathname.split('/')[3];
    cancelSchedule(id);
    return json(res, 200, { ok: true });
  }

  // ─── History ──────────────────────────────────────────────────
  if (pathname === '/api/history' && req.method === 'GET') {
    return json(res, 200, readHistory().slice(0, 100));
  }

  if (pathname === '/api/history' && req.method === 'DELETE') {
    try { fs.writeFileSync(HISTORY_PATH, '[]', 'utf8'); } catch {}
    return json(res, 200, { ok: true });
  }

  // ─── Backup / Restore ─────────────────────────────────────────
  if (pathname === '/api/backup' && req.method === 'GET') {
    const cfg = loadConfig();
    const data = Buffer.from(JSON.stringify(cfg, null, 2), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Content-Disposition': 'attachment; filename="terminal-runner-backup.json"',
    });
    res.end(data);
    return;
  }

  if (pathname === '/api/restore' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const incoming = body.config || body;
      if (!incoming || !Array.isArray(incoming.apps)) return json(res, 400, { error: 'Invalid backup: missing apps array' });
      const cur = loadConfig();
      try { fs.writeFileSync(path.join(__dirname, 'config.backup.json'), JSON.stringify(cur, null, 2), 'utf8'); } catch {}
      const cfg = loadConfig();
      cfg.apps = incoming.apps;
      if (incoming.telegram_chat_id !== undefined) cfg.telegram_chat_id = incoming.telegram_chat_id;
      if (incoming.download_dir) cfg.download_dir = incoming.download_dir;
      if (incoming.telegram_lang === 'ar' || incoming.telegram_lang === 'en') cfg.telegram_lang = incoming.telegram_lang;
      if (Array.isArray(incoming.schedules)) cfg.schedules = incoming.schedules.filter(s => s && s.id && s.appId && s.runAt && s.runAt > Date.now());
      if (incoming.telegram_token) cfg.telegram_token = incoming.telegram_token;
      saveConfig(cfg);
      for (const [, t] of scheduleTimers) clearTimeout(t);
      scheduleTimers.clear();
      rescheduleAll();
      startTelegramBot(cfg.telegram_token, cfg.telegram_chat_id);
      return json(res, 200, { ok: true, apps: cfg.apps.length });
    } catch (e) {
      return json(res, 400, { error: 'Restore failed: ' + (e?.message || '') });
    }
  }

  // ─── Quick system actions ─────────────────────────────────────
  if (pathname.startsWith('/api/system/') && req.method === 'POST') {
    const key = pathname.split('/')[3];
    if (!runQuick(key)) return json(res, 404, { error: 'Unknown action (lock/recycle/desktop/taskmgr)' });
    return json(res, 200, { ok: true, action: key });
  }

  // Open Web UI in the server's default browser (used by Telegram 🌍 button)
  if (pathname === '/api/open-browser' && req.method === 'POST') {
    openBrowserUI();
    return json(res, 200, { ok: true, url: `http://localhost:${PORT}` });
  }

  // Static files
  serveStatic(res, pathname);
});

server.listen(PORT, () => {
  console.log(`🚀 Terminal Telegram Runner running on http://localhost:${PORT}`);
  const cfg = loadConfig();
  if (cfg.telegram_token) {
    console.log('🤖 Telegram bot: starting...');
    startTelegramBot(cfg.telegram_token, cfg.telegram_chat_id);
  } else {
    console.log('⚠️  No Telegram token configured. Set it in the web UI.');
  }
  // Run apps with startup=true after a short delay
  setTimeout(() => syncStartupApps(), 2000);
  // Re-arm persistent schedules
  setTimeout(() => rescheduleAll(), 2500);
});

// Graceful shutdown
process.on('SIGINT', () => {
  stopTelegramBot();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopTelegramBot();
  process.exit(0);
});

// Never die silently: log crashes instead (diagnosable via server-errors.log)
function logCrash(kind, err) {
  try {
    fs.appendFileSync(path.join(__dirname, 'server-errors.log'),
      `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || err}\n`);
  } catch {}
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (r) => logCrash('unhandledRejection', r));
