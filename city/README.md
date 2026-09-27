# Avtoshahar — 3D shahar haydash simulyatori

O'zbekiston Respublikasi Yo'l harakati qoidalari (YHQ) asosidagi yuqori
unumdorlikli 3D **«Mashinalar shahri»** simulyatori. Brauzer (Web), Android
(APK) va Windows (EXE) uchun bitta kodbazadan yig'iladi. Avtomobil modellari,
yo'l belgilari va teksturalari asosiy Avtodrom loyihasidan
(`../game/assets`) qayta ishlatiladi.

> A high-performance 3D "City of Cars" driving simulator governed by the Road
> Traffic Rules of Uzbekistan, built with Three.js and TypeScript. Ships as
> Web, Android APK and Windows EXE from a single codebase.

## Xususiyatlar / Features

- **Mikroskopik transport oqimi** — har bir avtomobil mustaqil agent:
  - **IDM** (Intelligent Driver Model) — bo'ylama tezlanish/tormozlanish.
  - **MOBIL** — xushmuomalalik omili (*politeness*) va xavfsizlik mezoni bilan
    qatorni almashtirish; yaxlit chiziq (1.1/1.3) manevrni bloklaydi.
  - Chorrahalarda ustunlik ierarxiyasi: **tartibga soluvchi → svetofor →
    vaqtinchalik belgilar → doimiy belgilar → chiziqlar → tenglik (o'ng qo'l
    qoidasi)**, konflikt nuqtalari va deadlock oldini olish.
  - Piyodalar — svetoforli va nomuvofiq o'tish joylarida ("zebra") ustunlik.
- **YHQ bazasi** — 7 guruh yo'l belgilari (`src/rules/PddKnowledge.ts`), rasmiy
  jarima jadvali, tezlik cheklovlari, nogironlar (7.17) uchun istisnolar va
  1.24 razmetkali maxsus turargoh joylari.
- **O'yin rejimlari:** Erkin haydash · Taksi topshiriqlari (A* navigatsiya,
  Web Worker) · Shahar imtihoni (20 jarima balida "o'tmadi") · Transport oqimi
  kuzatuvchisi.
- **Avtomobil fizikasi** — Avtodrom C++ presetlaridan portlangan (Nexia 2
  mexanika / Cobalt avtomat): dvigatel momenti egri chiziqlari, mufta yoki
  gidrotransformator, uzatmalar, shina modeli, ABS, yuk ko'chishi.
- **Renderer** — InstancedMesh, frustum culling, LOD, kun/tun sikli, ob-havo
  (yomg'ir/tuman), tungi faralar va ko'cha chiroqlari.
- **WebGPU benchmark** — 100 000 avtomobil to'liq GPU'da (WGSL IDM+MOBIL
  compute shader, CPU'ga qaytarishsiz).
- **Tillar:** o'zbek (lotin), o'zbek (kirill), rus.

## Ishga tushirish / Development

```bash
cd city
npm install
npm run dev        # http://localhost:5173  (assets avtomatik ko'chiriladi)
```

`npm run assets` `../game/assets` dan mashina GLB'lari, belgilar va
teksturalarni `public/assets` ga ko'chiradi (git'da saqlanmaydi).

## Yig'ish / Builds

| Target | Buyruq | Natija |
|---|---|---|
| Web | `npm run build` | `dist/` (statik, PWA, GitHub Pages) |
| Windows | `npm run dist:win` | `release/Avtoshahar-Setup-*.exe` + portable |
| Linux | `npm run dist:linux` | `release/*.AppImage` |
| Android | `npm run apk` | `android/app/build/outputs/apk/debug/app-debug.apk` |

Windows/Linux Electron bilan, Android Capacitor bilan o'raladi. Android uchun
JDK 17/21 va Android SDK kerak (CI'da avtomatik o'rnatiladi).

## CI / CD

`.github/workflows/avtoshahar.yml`:
- har bir push'da Web, APK va EXE yig'iladi va headless Chromium'da tekshiriladi;
- `main` Web versiyasini GitHub Pages'ga chiqaradi;
- `avtoshahar-v*` teg APK va EXE bilan GitHub Release yaratadi.

## Boshqaruv / Controls

W/↑ gaz · S/↓ tormoz · A/D yoki ←/→ rul · Space qo'l tormozi · Q/E burilish
chiroqlari · H avariya · L faralar · B kamar · C kamera · R/F uzatma ↑/↓
(mexanika) · Shift mufta · N neytral · I dvigatelni yurgizish · G signal ·
M xarita · Esc pauza. Geympad va sensorli boshqaruv qo'llab-quvvatlanadi.

## Arxitektura / Architecture

```
city/src/
  rules/PddKnowledge.ts      YHQ belgilari, jarimalar, IDM/MOBIL parametrlari
  world/TrafficRuleGraph.ts  protsedural shahar → yo'nalishli qator grafi
  world/WorldBuilder.ts      geometriya: yo'l, razmetka, bino, belgi, svetofor
  world/SignTextures.ts      belgi teksturalari (rasmiy PNG yoki chiziladi)
  traffic/TrafficSim.ts      IDM + MOBIL + chorraha mantiqi (SoA, 1000+ agent)
  traffic/TrafficRenderer.ts instansli render, culling, LOD, chiroqlar
  traffic/Pedestrians.ts     piyodalar grafi va o'tish joylari
  vehicle/VehiclePhysics.ts  o'yinchi fizikasi (C++ presetdan port)
  vehicle/PlayerCar.ts       GLB model, g'ildirak/rul/chiroqlar
  vehicle/CameraRig.ts       kabina / orqadan / yuqoridan kamera
  vehicle/EngineAudio.ts     protsedural dvigatel/shina tovushi
  input/InputManager.ts      klaviatura / geympad / sensor
  game/Navigator.ts          A* worker bilan GPS
  game/RuleMonitor.ts        o'yinchi qoidabuzarliklari
  game/Collisions.ts         SAT + impuls to'qnashuvlar
  game/Missions.ts           taksi va imtihon rejimlari
  game/Game.ts               asosiy tsikl
  gpu/                        WebGPU 100k benchmark (WGSL)
  ui/                        menyu, HUD, minixarita, sozlamalar
  workers/                   A* path-finder
```

## Litsenziya

MIT. Asosiy Avtodrom loyihasidagi CC0 teksturalar Poly Haven'dan
(`../game/assets/**/SOURCE.txt`).
