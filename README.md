# Archie-Jumi

Desktop Kitten Companions: an offline Windows 11 desktop-pet app starring two kittens, gray-and-white Archie and orange tabby Jumi. They wander, nap, groom, chase yarn, eat treats and react to petting on top of your other windows, without blocking clicks meant for other apps.

- **App source:** [`archie-jumi-app/`](archie-jumi-app/). Its README covers running from source, controls, troubleshooting and the architecture.
- **Release notes:** [`archie-jumi-app/docs/release-notes.md`](archie-jumi-app/docs/release-notes.md) (current version 1.1.0).
- **What was tested:** [`archie-jumi-app/docs/VALIDATION.md`](archie-jumi-app/docs/VALIDATION.md).
- **Upgrade plan behind 1.0.2 and 1.1.0:** [`archie-and-jumi-upgrade-plan.md`](archie-and-jumi-upgrade-plan.md).

Quick start (Node.js 24 LTS on Windows x64):

```powershell
cd archie-jumi-app
npm ci
npm start
```

`npm run make` builds an unsigned Windows installer under `archie-jumi-app/out/make/`.

The kitten artwork is AI-generated from photos of the real Archie and Jumi; the original photos are not part of this repository.
