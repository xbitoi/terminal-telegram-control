# Terminal Telegram Control

> **Control your Windows PC remotely via Telegram and Web UI.**
> Launch apps, capture screenshots, manage files, schedule runs, and shut down or restart — all from your phone or browser.

[بالفصحى ⬅️](README.ar.md) · [بالدّارجة ⬅️](README.darija.md) · [Français ➡️](README.fr.md)

Developed by **[xboy](https://github.com/xbitoi)**.

---

## Features

| Area | What you get |
|---|---|
| 🤖 **Telegram bot** | Inline menu with your apps; add, edit, delete apps remotely; one-tap run |
| ⌨️ **Quick buttons** | Persistent reply keyboard: screenshot, files, history, stop, startup, open UI, language |
| 📸 **Screenshot** | Capture the PC screen and receive it on Telegram, or view it in the Web UI (no extra tools) |
| 📁 **File manager** | Browse drives and folders, download files PC → phone (45MB max), upload phone → PC; upload/download from the Web UI too, with a native Windows folder picker |
| ⏰ **Schedules** | Schedule any app to run later; schedules survive restarts; cancel anytime from Telegram or Web |
| 🕘 **History & running** | Live process tracking with per-app ⏹ stop buttons, boot-app status, and last-run log |
| 🔥 **Startup manager** | Per-app auto-run on Windows boot + server auto-start toggle (Startup folder shortcut) |
| ⚡ **Quick actions** | Lock PC, empty Recycle Bin, minimize all windows, open Task Manager |
| 🌐 **Web UI** | Dark bilingual dashboard: apps CRUD, run/stop, schedules, files, screenshot, settings, backup/restore, send message/file to Telegram |
| 💾 **Backup / restore** | Export and import the whole configuration as JSON from the Web UI |
| 🛡️ **Safety** | Restart/shutdown ask for confirmation; bot locked to your Chat ID; duplicate-tap protection |
| 🌍 **Bilingual** | Full Arabic (RTL) / English in bot, Web UI, and docs |
| 🎭 **Demonic / angelic themes** | Bat wings + rising embers (satanic) vs feathered wings + halo + falling light (angelic); one-click toggle, remembered |
| 🐚 **Shells** | `cmd`, PowerShell, and Git Bash; each app can chain multiple commands |

## Themes

The Web UI ships with two animated themes, switchable with the 😇/😈 button
(choice is remembered): **satanic** — bat wings with rising embers and
"H3LL G4T3" branding; **angelic** — feathered wings, glowing halo, and falling
motes of light with "ANGEL GATE" branding.

## Requirements

- Windows 10/11 (`shutdown`, `taskkill`, `notepad` are built in)
- Node.js 18+ (`fetch` is built in — check with `node --version`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your Chat ID from [@userinfobot](https://t.me/userinfobot)

## Install

```bash
git clone https://github.com/xbitoi/terminal-telegram-control.git
cd terminal-telegram-control
npm install
node server.js
```

Open **http://localhost:3770** in your browser. Or double-click `run.bat`.
A fresh install starts with 6 built-in Windows apps (Restart, Shutdown, Lock, Notepad, Calculator, Task Manager) — add yours from Telegram `/add` or the Web UI.
To auto-start with Windows, run `install-startup.ps1` (no admin needed) or toggle it in the Web UI / Telegram 🔥 menu.

## Configure

**Via Web UI (recommended):** open the page → *Telegram settings* → paste token
+ Chat ID (+ download folder, language) → *Save*. The bot connects immediately.

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

## Usage

### Telegram

Send `/start` → inline menu with all your apps. Tap to run (restart/shutdown ask
for confirmation first), or manage with ➕ Add / ✏️ Edit / 🗑 Delete / ⏹️ Stop.

| Command | Description |
|---|---|
| `/start`, `/menu` | Main menu (apps) |
| `/screenshot` | Capture PC screen |
| `/files` | Browse PC files |
| `/history` | Running apps, boot apps, last runs |
| `/stop` | Stop a running app |
| `/startup` | Boot auto-run settings |
| `/schedules` | Scheduled runs (tap to cancel) |
| `/add`, `/edit`, `/delete` | Manage apps |
| `/lang` | Switch language (AR/EN) |
| `/browser` | Open the Web UI on the PC |
| `/restart`, `/shutdown`, `/notepad` | Direct shortcuts (if you define these apps) |

The quick reply keyboard (⌨️ under the typing box) gives instant access to
screenshot, files, history, stop, startup, and language. Any photo, video, or
file you send to the bot is saved straight to the download folder on the PC.

### Web UI

Open `http://localhost:3770`: run apps with ▶, stop them with ⏹, toggle
per-app boot auto-run, schedule runs, browse/upload/download files, take
screenshots, change Telegram settings, trigger quick actions, and
backup/restore the configuration.

### Adding apps

Each app has a name plus one or more commands. Examples:

| App | Commands |
|---|---|
| Notepad | `notepad` |
| Restart PC | `shutdown /r /t 3` |
| Shutdown | `shutdown /s /t 0` |
| Dev servers | `opencode-telegram start` + `opencode serve` |

Add them from Telegram (`/add` walks you through name → command) or from the Web UI.

## Project structure

```
terminal-telegram-control/
├── server.js               # HTTP server + Telegram bot (all features)
├── public/index.html        # dark bilingual Web UI
├── config.json              # your apps + secrets (git-ignored, created by you)
├── config.example.json      # starter template (Restart/Shutdown/Notepad)
├── run.bat                  # double-click launcher for Windows
├── install-startup.ps1      # registers auto-start with Windows (no admin)
├── test-per-app-startup.sh  # sanity checks for the startup feature
└── package.json
```

## API

| Method | Path | Description |
|---|---|---|
| GET/POST | `/api/apps` | List / create apps |
| PUT/DELETE | `/api/apps/:id` | Update / delete an app |
| POST | `/api/apps/:id/run` | Execute an app's commands |
| POST | `/api/apps/:id/startup` | Toggle boot auto-run for an app |
| GET | `/api/running` | Live processes + boot-app status |
| POST | `/api/running/stop` | Kill running processes |
| GET | `/api/screenshot` | Capture screen (PNG) |
| GET | `/api/files`, `/api/files/dirs`, `/api/files/drives` | Browse files/folders/drives |
| GET | `/api/files/download` | Download a file (100MB max) |
| POST | `/api/files/upload`, `/api/files/pick-folder` | Upload a file / native folder picker |
| GET/POST/DELETE | `/api/schedules` | List / create / cancel scheduled runs |
| GET/DELETE | `/api/history` | Last runs / clear |
| GET/POST | `/api/settings` | Telegram settings (token never exposed in full) |
| GET | `/api/bot/status` | Bot connection status |
| POST | `/api/bot/send`, `/api/bot/send-file` | Send message / file to Telegram |
| GET/POST | `/api/startup` | Server auto-start with Windows |
| POST | `/api/system/:key` | Quick action (`lock`/`recycle`/`desktop`/`taskmgr`) |
| GET/POST | `/api/backup`, `/api/restore` | Export / import configuration |

## Security notes

- The bot ignores messages from any Chat ID other than yours.
- Restart/shutdown always require an explicit confirmation tap/click.
- The token is shown truncated everywhere; the full value lives only in your local `config.json`.
- Keep your bot token private. If it leaks, revoke it via [@BotFather](https://t.me/BotFather) → `/revoke`.

## Developer

**xboy** — [github.com/xbitoi](https://github.com/xbitoi)

## License

MIT — do what you want.
