# Terminal Telegram Control

> **Remote-control your Windows PC from Telegram or a browser — 3 fixed actions only.**
> Restart, shut down, or open Notepad. No free commands, no surprises.

[بالفصحى ⬅️](README.ar.md) · [بالدّارجة ⬅️](README.darija.md) · [Français ➡️](README.fr.md)

---

## Why this exists

Most "PC remote" tools execute any command you send — convenient, but a leaked
bot token means full remote code execution on your computer. This project takes
the opposite approach: the server can only run **3 whitelisted OS commands**,
everything else is rejected. Safe to keep online, easy to audit.

| Action | What it runs | Confirmation |
|---|---|---|
| 🔄 Restart PC | `shutdown /r /t 3` | Yes — Telegram + Web |
| ⏻ Shutdown | `shutdown /s /t 0` | Yes — Telegram + Web |
| 📝 Open Notepad | `notepad` | No (harmless) |

## Features

- 🤖 **Telegram bot** — `/start` shows 3 inline buttons, confirm step for restart/shutdown
- 🌐 **Web UI** — dark bilingual interface, same 3 actions + confirm modal
- 🛡️ **Allowlist only** — no custom commands, no file browser, no screenshots
- 🔒 **Single-user lock** — bot answers only your Chat ID
- 🌍 **Bilingual** — Arabic (RTL) / English toggle, synced between Web and Telegram
- 🪶 **Zero dependencies** — pure Node.js standard library, `npm install` installs nothing

## Requirements

- Windows 10/11 (`shutdown`, `notepad` are built in)
- Node.js 18+ (`fetch` is built in — check with `node --version`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) + your chat ID from [@userinfobot](https://t.me/userinfobot)

## Install

```bash
git clone https://github.com/xbitoi/terminal-telegram-control.git
cd terminal-telegram-control
npm install   # no-op today, keeps you future-proof
node server.js
```

Open **http://localhost:3770**. Or double-click `run.bat`.

## Configure

**Via Web UI (recommended):** open the page → *Telegram settings* → paste token
+ chat ID → *Save*. The bot connects immediately, no restart needed.

**Via file:** copy the template and fill it in:

```bash
cp config.example.json config.json
```

```json
{
  "telegram_token": "123456:ABC...",
  "telegram_chat_id": "123456789",
  "telegram_lang": "ar"
}
```

> `config.json` is git-ignored. Never commit your real token.

## Use

**Telegram:** send `/start` → tap 🔄 / ⏻ / 📝. Restart and shutdown ask for
confirmation first. Direct commands `/restart`, `/shutdown`, `/notepad` work too.

**Web:** open `http://localhost:3770` → *Run* on any card. Dangerous actions pop
a confirm dialog.

## Project structure

```
terminal-telegram-control/
├── server.js            # HTTP + Telegram bot, allowlist of 3 actions
├── public/index.html    # dark bilingual Web UI
├── config.json          # your secrets (git-ignored, created by you)
├── config.example.json  # template
├── run.bat              # double-click launcher for Windows
└── package.json         # zero dependencies
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/actions` | List the 3 fixed actions |
| POST | `/api/actions/:key/run` | Run one (`restart`/`shutdown`/`notepad`) |
| GET | `/api/settings` | Chat ID, language, bot status (token never exposed) |
| POST | `/api/settings` | Save token/chat ID/language, restarts bot |
| GET | `/api/bot/status` | `{ running: true/false }` |

## Security notes

- The server **cannot** run anything outside the 3-entry `ACTIONS` map in `server.js` — audit it in 30 seconds.
- Telegram updates from other chat IDs are ignored.
- Restart/shutdown always require an explicit second tap/click.
- Keep your bot token private. If it leaks, revoke it via [@BotFather](https://t.me/BotFather) → `/revoke`.

## License

MIT — do what you want.
