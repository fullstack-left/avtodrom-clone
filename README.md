# Avtodrom

Toshkent imtihon olish markazi (YIM) avtodromidagi amaliy haydovchilik
imtihonining simulyatori. Android (asosiy) va Windows uchun.

- Avtodrom rasmiy sxema bo'yicha qurilgan (12 px = 1 m; yo'l bo'laklari
  ~3.2–3.7 m). Marshrutdagi har bir burilishdan oldin buyuruvchi belgi
  (4.1.x) turadi.
- 12 ta mashq va imtihon rasmiy 32 bandli jarima jadvali bo'yicha baholanadi
  (100 balldan kam — "o'tdi"; 100 ga yetganda imtihon darhol to'xtaydi).
- Haqiqiy fizika: dvigatel, ilashish (mufta), 5 pog'onali mexanika yoki
  avtomat, shinalar modeli, ABS, osma — hammasi C++ da.
- Ikki mashina: **Nexia 2** (mexanika, 5 pog'ona) va **Cobalt** (avtomat,
  6 pog'ona) — har biri zavod ma'lumotlari bo'yicha (massa, dvigatel
  momenti, uzatmalar, g'ildirak bazasi, shinalar).
- Uch rejim:
  - **Imtihon** — to'liq marshrut, ko'rsatmalarsiz, natija tarixga yoziladi;
    imtihon paytida "qaytadan boshlash" yo'q (chiqish = o'tmadi, №26).
    Kirish sahifasida "Namuna" — butun imtihonni avtopilot topshiradi.
  - **Mashqlar** — istalgan mashq alohida, qisqa ko'rsatmalar va marshrut
    chizig'i bilan; har birida "Namuna".
  - **Erkin haydash**.
- Maydon atrofida: aylanma yo'l, imtihon markazi binosi va turargoh (turgan
  mashinalar), teraklar va bog', uzoqda shahar siluetlari.
- Kamera: kabina, orqadan (yaqin), yuqoridan. Ekranning bo'sh joyini surib
  360° aylantirish, ikki barmoq / g'ildirak bilan yaqinlashtirish; ustun va
  belgilar orqasiga tushmaydi.
- Tillar: o'zbek (lotin), o'zbek (kirill), rus.

## Texnologiyalar

| Qatlam | Nima |
|---|---|
| Dvigatel | Godot 4.7.2 (Mobile renderer, Vulkan), Jolt fizika, 120 Hz fizika + interpolyatsiya |
| Avtomobil fizikasi | C++17, GDExtension (godot-cpp 10.0.0, API 4.7) — `native/` |
| O'yin mantig'i, UI | GDScript — `game/src/` |
| Ma'lumot tayyorlash | Python 3 (OpenCV, shapely, Blender) — `pipeline/` |

## Katalog tuzilmasi

```
native/            C++ modul
  src/sim/         platformaga bog'liq bo'lmagan simulyator (shina, transmissiya, dvigatel)
  src/godot/       Godot bog'lamalari: AvtoVehicle (RigidBody3D), EngineSound
  tests/           C++ unit testlar (sim_tests)
game/              Godot loyihasi
  src/autoload/    Settings, Loc (tarjimalar), Session, DebugShots
  src/course/      avtodrom sahnasini qurish (yo'llar, chiziqlar, belgilar, svetoforlar)
  src/vehicle/     Car (model, chiroqlar, tovush), kamera
  src/exam/        imtihon: ExamDirector, mashqlar (ex_*.gd), marshrut kuzatuvchi, jarimalar
  src/game/        haydash sahnasi, avtopilot, ko'zgular, marshrut ko'rsatkichi
  src/ui/          menyu, HUD, pedallar, rul, sozlamalar, natijalar
  data/            course.json, penalties.json, i18n.json, sirt xaritalari (*.bin), course_baked.scn
  assets/          mashina modeli, teksturalar, belgilar, shrift, shaderlar
  tests/           vehicle_test.gd, render_test, bake_course.gd
pipeline/          sxemadan avtodrom geometriyasini chiqarish, tarjimalar, ikonka, teksturalar
  blender/         mashina modellarini o'yinga tayyorlash (build_nexia.py, build_cobalt.py,
                   build_car_lod.py — turargohdagi mashinalar uchun yengil versiya)
reference/         rasmiy sxema va mashqlar jadvallari (manba)
scripts/           build.py (to'liq yig'ish), run_tests.py (barcha testlar)
tools/             Godot va eksport shablonlari (git'da emas)
keys/              release keystore (MAXFIY — git'da emas)
export/            tayyor APK va EXE (git'da emas)
```

## Arxitektura qisqacha

- **VehicleSim (C++)** har bir fizika qadamida (1/120 s) shinalarni
  (deflection/relaxation-length + Magic Formula), transmissiya cheklovlarini
  (PGS yechuvchi: dvigatel, mufta, uzatmalar, tormoz, park qulfi), salt yurish
  regulyatori, o'chib qolish va starterni hisoblaydi. `AvtoVehicle` uni Jolt
  `RigidBody3D` ga ulaydi (osma — silindr shape-cast).
- **ExamDirector** mashqlarni (`Exercise` holat mashinalari) boshqaradi,
  umumiy qoidalarni (kamar, tezlik, o'chib qolish, marshrutdan chiqish,
  to'qnashuv, vaqt, burilish chiroqlari) kuzatadi va jarimalarni rasmiy jadval
  raqamlari bilan yozadi.
- **Avtodrom** `pipeline/course_def.py` da rasmiy sxemadan aniqlanadi va
  `game/data/course.json` + sirt/masofa xaritalariga yoziladi. O'yinda sahna
  oldindan "pishirilgan" (`course_baked.scn`) — telefonda tez yuklanadi.
- **Avtopilot** (pure pursuit + mashqlar uchun maxsus manevrlar) "Namuna"
  rejimida ishlaydi va avtomatik end-to-end test sifatida butun imtihonni 0
  jarima bilan topshiradi.

## Mashina modellari

Manba modellar `projects/car-game/assets-src/car-3d/` dan olinadi va Blender
(headless) skriptlari bilan qayta ishlanadi:

```
blender -b --python pipeline/blender/build_cobalt.py -- <chevrolet_cobalt_ltz.glb> game/assets/cars/cobalt/cobalt.glb
```

Skript haqiqiy o'lchamlarga moslaydi (Cobalt: uzunlik 4479 mm, baza 2620 mm),
g'ildiraklarni `Wheel_XX/Spin_XX`, chiroqlarni `Lamp_*`, rulni
`SteeringPivot/SteeringWheel` qilib ajratadi, uchburchaklar sonini mobil
byudjetgacha kamaytiradi (~110k) va to'qnashuv qobig'ini yasaydi.
Keyin `refine_car.py` tozalash bosqichi kuzov normallarini qayta hisoblaydi
(eshik va bagajdagi qora dog'lar yo'qoladi), kuzovni ~34–40k uchburchakgacha
yengillashtiradi va buzilgan torpedoni sodda modellangan torpedo, jonli
spidometr va taxometr (`GaugeSpeed`/`GaugeRpm`, `gauge.gdshader`) bilan
almashtiradi:

```
blender -b --python pipeline/blender/refine_car.py -- cobalt.glb game/assets/cars/cobalt/cobalt.glb cobalt_at
```

Natijani tekshirish: `godot --path game res://tests/car_render_test.tscn -- <papka> <nexia2|cobalt_at>`
(tashqi va saloni suratlari). Chiqqan
o'lchamlar (bamperlargacha masofa, ko'zgu nuqtasi) `game/src/vehicle/car.gd`
dagi `MODELS` ga, g'ildirak bazasi/koleya C++ presetiga yoziladi.

## Yig'ish

Talablar (Windows): Python 3.12+ (`pip install scons opencv-python shapely numpy`),
Visual Studio 2022 Build Tools (MSVC), Android uchun JDK 17 va Android SDK +
NDK 28.2.13676358. Godot 4.7.2 va eksport shablonlari `tools/` ichida.

Linux/macOS: MSVC o'rniga GCC/Clang. Godot `tools/godot/` dan
(`Godot_v4.7.2-stable_linux.x86_64` yoki `Godot.app`), `GODOT` muhit
o'zgaruvchisidan yoki PATH dagi `godot` dan olinadi; Android SDK `ANDROID_HOME`
dan. Windows eksporti faqat Windows'da yig'iladi.

Yangi klondan keyin avval `git submodule update --init` (godot-cpp), keyin
`build.py` — u `game/bin/` dagi C++ kutubxonalarni ham yaratadi.

```
python scripts/build.py               # C++ modul (Windows + Android), bake, eksportlar
python scripts/build.py --no-native   # faqat bake + eksport
python scripts/build.py --android     # faqat Android APK
```

Natija: `export/windows/Avtodrom.exe`, `export/android/avtodrom.apk`
(release, imzolangan) va `avtodrom-debug.apk`.

Release APK imzosi uchun `keys/avtodrom-release.keystore` va parollar
`keys/release_credentials.txt` da. **Bu fayllarni hech qachon repozitoriyga
qo'shmang va boshqalarga bermang** — Play Market'dagi ilovani yangilash faqat
shu kalit bilan mumkin; zaxira nusxasini xavfsiz joyda saqlang.

## Testlar

```
python scripts/run_tests.py           # hammasi (~35 daqiqa)
python scripts/run_tests.py --quick   # faqat C++ va avtomobil testlari
```

1. C++ simulyator unit testlari (47 ta).
2. Godot/Jolt avtomobil integratsiya testi (20 ta tekshiruv).
3. Butun imtihon avtopilot bilan, ikkala mashinada — 0 jarima kutiladi.
4. Ataylab xato qilish (kamarsiz, to'xtamaslik, qizil chiroq, burilish
   chirog'isiz, tezlikni oshirish) — to'g'ri jarima bandlari chiqishi kerak.
5. Har bir mashqning "Namuna"si alohida, ikkala mashinada — 0 jarima.

Qo'lda tekshirish uchun buyruq qatori (Godot `--` dan keyin):
`--mode=practice --exercise=box --demo`, `--car=cobalt_at`, `--camera=chase`, `--autopilot`,
`--seed=<n>` (svetofor fazalari takrorlanadi), `--touch` (telefon ko'rinishi kompyuterda),
`--shots=<papka>`, `--quit-after-s=<s>`, `--menu-page=exam|practice|rules|history|settings`.

## Boshqaruv (kompyuter)

Kompyuterda standart holda klaviatura bilan boshqariladi; ekrandagi rul va
pedallarni Sozlamalar → Boshqaruv → "Ekrandagi rul va pedallar" orqali yoqish
mumkin (sensorli ekranli noutbuklar uchun). Telefonda rul turi: rul,
strelkalar yoki telefonni qiyalatish.

| Tugma | Amal |
|---|---|
| W / ↑ | gaz |
| S / ↓ | tormoz |
| Shift / C | ilashish (mufta) |
| A D / ← → | rul |
| 1–5, R, N | uzatma (avtomatda P R N D: P, R, N, G) |
| I (bosib turish) | kalit / starter |
| B | xavfsizlik kamari |
| Space | qo'l tormozi |
| Q / E | chap / o'ng burilish chirog'i |
| H | avariya signali |
| V | kamera |
| Esc | pauza |
| sichqoncha bilan surish / g'ildirak | kamerani aylantirish / yaqinlashtirish |

Telefonda: rul (yoki tugmalar), gaz/tormoz/mufta pedallari, uzatma dastagi,
kalit/kamar/qo'l tormozi, burilish va avariya chiroqlari; ekranning bo'sh
joyini surish — kamerani aylantirish.

## Litsenziyalar va manbalar

- Teksturalar va osmon: Poly Haven (CC0).
- Shrift: Inter (SIL Open Font License, `game/assets/fonts/OFL.txt`).
- Yo'l belgilari va jarima jadvali: AvtoSmart (variant-vision-quiz) ma'lumotlari.
- Avtodrom sxemasi va mashqlar tavsifi: Toshkent YIM qo'llanmasi.
