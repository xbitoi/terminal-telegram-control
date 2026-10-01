# Contrôle PC via Telegram

> **Contrôlez votre PC Windows depuis Telegram ou un navigateur — toutes les fonctionnalités.**
> Lancez des applis, capturez l'écran, gérez les fichiers, planifiez des exécutions, éteignez ou redémarrez — tout depuis votre téléphone ou votre navigateur.

[English ➡️](README.md) · [بالفصحى ⬅️](README.ar.md) · [بالدّارجة ⬅️](README.darija.md)

Développé par **[xboy](https://github.com/xbitoi)**.

---

## Fonctionnalités

| Domaine | Ce que vous obtenez |
|---|---|
| 🤖 **Bot Telegram** | Menu avec vos applis ; ajouter, modifier, supprimer des applis à distance ; exécution en un toucher |
| ⌨️ **Boutons rapides** | Clavier persistant : capture d'écran, fichiers, historique, arrêt, démarrage, ouvrir l'UI, langue |
| 📸 **Capture d'écran** | Capturez l'écran du PC et recevez-la sur Telegram, ou regardez-la dans l'interface Web (sans outils supplémentaires) |
| 📁 **Gestionnaire de fichiers** | Parcourez disques et dossiers, téléchargez PC → téléphone (45 Mo max), envoyez téléphone → PC ; envoi/téléchargement aussi depuis le Web, avec sélecteur de dossier Windows natif |
| ⏰ **Planification** | Planifiez l'exécution d'une appli plus tard ; les planifications survivent au redémarrage ; annulez depuis Telegram ou le Web |
| 🕘 **Historique et en-cours** | Suivi live des processus avec boutons ⏹ par appli, état des applis au démarrage, journal des dernières exécutions |
| 🔥 **Gestionnaire de démarrage** | Lancement auto par appli au démarrage de Windows + interrupteur de démarrage auto du serveur |
| ⚡ **Actions rapides** | Verrouiller le PC, vider la Corbeille, réduire toutes les fenêtres, ouvrir le Gestionnaire des tâches |
| 🌐 **Interface Web** | Tableau de bord sombre et bilingue : CRUD des applis, exécution/arrêt, planification, fichiers, captures, paramètres, sauvegarde, envoi de messages/fichiers vers Telegram |
| 💾 **Sauvegarde** | Exportez et importez toute la configuration en JSON depuis le Web |
| 🛡️ **Sécurité** | Redémarrage/extinction avec confirmation ; bot verrouillé sur votre Chat ID ; protection anti-double-toucher |
| 🌍 **Bilingue** | Arabe complet (RTL) / anglais dans le bot, l'UI et la doc |
| 🐚 **Shells** | `cmd`, PowerShell et Git Bash ; chaque appli peut enchaîner plusieurs commandes |

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
Pour le démarrage auto avec Windows, exécutez `install-startup.ps1` (sans admin) ou activez-le depuis l'UI / le menu 🔥 de Telegram.

## Configuration

**Via l'interface (recommandé) :** ouvrez la page → *Paramètres Telegram* → collez
le token + le Chat ID (+ dossier de téléchargement, langue) → *Enregistrer*. Le bot se connecte aussitôt.

**Via fichier :** copiez le modèle et remplissez-le :

```bash
cp config.example.json config.json
```

> `config.json` est ignoré par git. Ne publiez jamais votre vrai token.

## Utilisation

### Telegram

Envoyez `/start` → menu avec vos applis. Touchez pour exécuter (redémarrage et
extinction demandent d'abord une confirmation), ou gérez avec ➕ Ajouter / ✏️ Modifier / 🗑 Supprimer / ⏹️ Arrêter.

| Commande | Description |
|---|---|
| `/start`, `/menu` | Menu principal (applis) |
| `/screenshot` | Capturer l'écran du PC |
| `/files` | Parcourir les fichiers du PC |
| `/history` | Applis en cours, applis au démarrage, dernières exécutions |
| `/stop` | Arrêter une appli en cours |
| `/startup` | Réglages de démarrage avec Windows |
| `/schedules` | Exécutions planifiées (touchez pour annuler) |
| `/add`, `/edit`, `/delete` | Gérer les applis |
| `/lang` | Changer de langue (AR/EN) |
| `/browser` | Ouvrir l'interface Web sur le PC |

Le clavier rapide (⌨️ sous la zone de saisie) donne un accès instantané à la
capture, aux fichiers, à l'historique, à l'arrêt, au démarrage et à la langue.
Toute photo, vidéo ou fichier envoyé au bot est enregistré directement dans le
dossier de téléchargement du PC.

### Interface Web

Ouvrez `http://localhost:3770` : exécutez les applis avec ▶, arrêtez-les avec ⏹,
activez le lancement auto par appli au démarrage, planifiez des exécutions,
parcourez/envoyez/téléchargez des fichiers, capturez l'écran, modifiez les
paramètres Telegram, déclenchez les actions rapides, et sauvegardez/restaurez
la configuration.

### Ajouter des applis

Chaque appli a un nom et une ou plusieurs commandes. Exemples :

| Appli | Commandes |
|---|---|
| Bloc-notes | `notepad` |
| Redémarrer le PC | `shutdown /r /t 3` |
| Éteindre | `shutdown /s /t 0` |

Ajoutez-les depuis Telegram (`/add` vous guide : nom puis commande) ou depuis l'interface Web.

## Structure du projet

```
terminal-telegram-control/
├── server.js               # Serveur HTTP + bot Telegram (toutes les fonctionnalités)
├── public/index.html        # Interface Web sombre et bilingue
├── config.json              # Vos applis + secrets (ignoré par git, créé par vous)
├── config.example.json      # Modèle de départ (Redémarrer/Éteindre/Bloc-notes)
├── run.bat                  # Lancement en un clic pour Windows
├── install-startup.ps1      # Démarrage auto avec Windows (sans admin)
├── test-per-app-startup.sh  # Tests de la fonction de démarrage auto
└── package.json
```

## Notes de sécurité

- Le bot ignore les messages de tout Chat ID autre que le vôtre.
- Redémarrage et extinction exigent toujours une confirmation explicite.
- Le token s'affiche tronqué partout ; sa valeur complète vit uniquement dans votre `config.json` local.
- Gardez votre token de bot privé. En cas de fuite, révoquez-le via [@BotFather](https://t.me/BotFather) → `/revoke`.

## Développeur

**xboy** — [github.com/xbitoi](https://github.com/xbitoi)

## Licence

MIT — faites-en ce que vous voulez.
