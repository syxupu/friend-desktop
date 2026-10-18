# Third-party components

## SillyTavern

- Source: https://github.com/SillyTavern/SillyTavern
- Version: 1.19.0
- Commit: `7e8663cd9c184a550b37238218bdd32c6efc68e9`
- License: AGPL-3.0 (bundled `resources/SillyTavern/LICENSE`)
- This prototype does not modify its upstream source. It loads a Friend bridge in its genuine browser frontend and invokes its character/worldbook generation pipeline.
- Reproducible source/dependency acquisition: `npm run setup`. The corresponding bridge/app source is in this project.

## Node.js

- Source: https://nodejs.org/dist/v24.14.0/
- Version: 24.14.0 Windows x64
- License: bundled `resources/node/LICENSE`, including applicable third-party notices.
- Official archive SHA256 checked by `scripts/setup-node.mjs`; metadata in `resources/node/runtime.json`.

## Electron and JavaScript dependencies

Electron: https://github.com/electron/electron (MIT and bundled third-party license notices). Package versions are fixed by `package-lock.json`. SillyTavern dependencies are fixed by its upstream `package-lock.json`; their license files remain bundled with the runtime. Development tooling is listed separately in `package.json`.

## User-provided assets

Character cards and their embedded lorebooks are supplied locally by each user and are **not included in this repository**. The application currently expects a local V3 JSON card at `assets/characters/主人的猫.json`; this compatibility filename does not require any specific persona.

`assets/pets/wanxiang-fox/sprites/` contains the eight pet images from the user-provided `wanxiang-fox.zip` (万象谱狐狸素材). Their original rights remain with their respective authors; this project's AGPL grant does not relicense these images. Import archives, original preset scripts and private asset extraction reports are excluded from this repository.
