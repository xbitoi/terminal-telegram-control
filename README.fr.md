# Contrôle PC via Telegram

> **Contrôlez votre PC Windows depuis Telegram ou un navigateur — 3 actions fixes uniquement.**
> Redémarrer, éteindre ou ouvrir le Bloc-notes. Aucune commande libre, aucune surprise.

[English ➡️](README.md) · [بالفصحى ⬅️](README.ar.md) · [بالدّارجة ⬅️](README.darija.md)

---

## Pourquoi ce projet ?

La plupart des outils de contrôle à distance exécutent n'importe quelle commande
envoyée — pratique, mais un token de bot qui fuit signifie une exécution de code
à distance complète sur votre ordinateur. Ce projet fait l'inverse : le serveur
ne peut exécuter que **3 commandes autorisées**, tout le reste est refusé.
Sûr et facile à auditer.

| Action | Commande exécutée | Confirmation |
|---|---|---|
| 🔄 Redémarrer | `shutdown /r /t 3` | Oui — Telegram + Web |
| ⏻ Éteindre | `shutdown /s /t 0` | Oui — Telegram + Web |
| 📝 Ouvrir le Bloc-notes | `notepad` | Non (inoffensif) |

## Fonctionnalités

- 🤖 **Bot Telegram** — `/start` affiche 3 boutons, avec confirmation pour redémarrage/extinction
- 🌐 **Interface Web** — sombre, bilingue, mêmes actions + fenêtre de confirmation
- 🛡️ **Liste blanche uniquement** — pas de commandes personnalisées, pas d'explorateur de fichiers, pas de captures d'écran
- 🔒 **Utilisateur unique** — le bot ne répond qu'à votre Chat ID
- 🌍 **Documentation en 4 langues** — arabe littéraire, darija marocaine, anglais, français
- 🪶 **Zéro dépendance** — Node.js pur, bibliothèque standard uniquement

## Prérequis

- Windows 10/11
- Node.js 18+ (vérifiez avec `node --version`)
- Un token de bot via [@BotFather](https://t.me/BotFather) + votre Chat ID via [@userinfobot](https://t.me/userinfobot)

## Installation

```bash
git clone https://github.com/xbitoi/terminal-telegram-control.git
cd terminal-telegram-control
npm install
node server.js
```

Ouvrez **http://localhost:3770** dans le navigateur. Ou double-cliquez sur `run.bat`.

## Configuration

**Via l'interface (recommandé) :** ouvrez la page → *Paramètres Telegram* → collez
le token + le Chat ID → *Enregistrer*. Le bot se connecte aussitôt, sans redémarrage.

**Via fichier :** copiez le modèle et remplissez-le :

```bash
cp config.example.json config.json
```

> `config.json` est ignoré par git. Ne publiez jamais votre vrai token.

## Utilisation

**Telegram :** envoyez `/start` → touchez 🔄 / ⏻ / 📝. L'extinction et le
redémarrage demandent d'abord une confirmation. Les commandes directes
`/restart`, `/shutdown` et `/notepad` fonctionnent aussi.

**Web :** ouvrez `http://localhost:3770` → *Exécuter* sur n'importe quelle carte.
Les actions dangereuses affichent un dialogue de confirmation.

## Structure du projet

```
terminal-telegram-control/
├── server.js            # Serveur + bot, liste des 3 actions
├── public/index.html    # Interface Web sombre et bilingue
├── config.json          # Vos secrets (ignoré par git, créé par vous)
├── config.example.json  # Modèle
├── run.bat              # Lancement en un clic pour Windows
└── package.json         # Aucune dépendance
```

## Notes de sécurité

- Le serveur **ne peut rien** exécuter en dehors de la table `ACTIONS` dans `server.js` — auditez-la en 30 secondes.
- Les messages Telegram d'un autre Chat ID sont ignorés.
- L'extinction et le redémarrage exigent toujours un second appui de confirmation.
- En cas de fuite du token, révoquez-le via [@BotFather](https://t.me/BotFather) → `/revoke`.

## Licence

MIT — faites-en ce que vous voulez.
