// Localisation: Uzbek (Latin) is the source language, Uzbek (Cyrillic) is
// produced by a transliterator, Russian is hand written.

export type Lang = 'uz_lat' | 'uz_cyr' | 'ru';

const UZ: Record<string, string> = {
  title: 'Avtoshahar',
  subtitle: "O'zbekiston YHQ asosidagi 3D shahar haydash simulyatori",
  play_free: 'Erkin haydash',
  play_missions: 'Topshiriqlar (taksi)',
  play_exam: 'Shahar imtihoni',
  play_spectate: 'Transport oqimi (kuzatuvchi)',
  gpu_bench: 'GPU benchmark (WebGPU, 100 000 mashina)',
  settings: 'Sozlamalar',
  rules: "YHQ ma'lumotnomasi",
  back: 'Orqaga',
  resume: 'Davom etish',
  restart: 'Qaytadan',
  main_menu: 'Bosh menyu',
  car: 'Mashina',
  car_nexia2: 'Nexia 2 (mexanika, 5 pog\'ona)',
  car_cobalt_at: 'Cobalt (avtomat, 6 pog\'ona)',
  language: 'Til',
  quality: 'Grafika sifati',
  q_low: 'Past',
  q_medium: "O'rta",
  q_high: 'Yuqori',
  traffic_density: 'Transport zichligi',
  pedestrians: 'Piyodalar',
  time_of_day: 'Kun vaqti',
  day: 'Kunduz',
  evening: 'Kechqurun',
  night: 'Tun',
  weather: 'Ob-havo',
  clear: 'Ochiq',
  rain: "Yomg'ir",
  fog: 'Tuman',
  lights_mode: 'Svetoforlar',
  lights_normal: 'Oddiy rejim',
  lights_flash: "Sariq miltillovchi (tungi)",
  officer: 'Tartibga soluvchi (markaziy chorraha)',
  on: 'Yoqilgan',
  off: "O'chirilgan",
  transmission_auto: 'Avtomat',
  clutch_mode: 'Mexanik uzatma muftasi',
  clutch_assist: 'Yordamchi mufta (tavsiya etiladi)',
  clutch_full: "To'liq qo'lda boshqarish",
  selector: 'Selektor',
  coach_title: 'Haydashga tayyorlaning',
  coach_belt: 'B — xavfsizlik kamarini taqing',
  coach_ready: 'Mashina harakatga tayyor',
  coach_drive: 'W/↑ — gaz, S/↓ — tormoz',
  coach_steer: 'A/D yoki ←/→ — rul',
  coach_manual: 'Z/X — uzatma −/+, Shift — mufta',
  coach_selector: 'V — Drive, R — Reverse, N — Neutral, P — Park',
  clutch: 'Mufta',
  stopped_fraction: "To'xtaganlar",
  reservations: 'Chorraha grantlari',
  sound: 'Tovush',
  controls: 'Boshqaruv',
  controls_text:
    "W/↑ — gaz, S/↓ — tormoz, A/D yoki ←/→ — rul, Space — qo'l tormozi, Q/E — burilish chiroqlari, H — avariya chirog'i, L — faralar, B — kamar, C — kamera, Z/X — uzatma −/+ (mexanika), Shift — mufta, V — Drive/1, R — Reverse, N — neytral, P — park, I — dvigatel, G — signal, M — xarita, Esc — pauza. Geympad ham qo'llab-quvvatlanadi.",
  speed_limit: 'Tezlik cheklovi',
  penalty: 'Jarima',
  points: 'ball',
  violations: 'Qoidabuzarliklar',
  no_violations: "Qoidabuzarlik yo'q — barakalla!",
  score: 'Ball',
  money: "So'm",
  time: 'Vaqt',
  distance: 'Masofa',
  exam_passed: "IMTIHON TOPSHIRILDI",
  exam_failed: "IMTIHON TOPSHIRILMADI",
  exam_intro:
    "Imtihonchi yo'nalishni ovozli ko'rsatma beradi. Barcha YHQ talablariga rioya qiling. 20 ball va undan ortiq jarima — imtihon topshirilmagan hisoblanadi.",
  mission_intro: "Yo'lovchini oling va manzilga qoidalarni buzmasdan yetkazing.",
  pickup: "Yo'lovchini oling",
  dropoff: 'Manzilga yetkazing',
  mission_done: 'Buyurtma bajarildi',
  fare: "Yo'l haqi",
  fine_total: 'Jarimalar',
  next_turn_left: 'Keyingi chorrahada chapga buriling',
  next_turn_right: "Keyingi chorrahada o'ngga buriling",
  next_straight: "Keyingi chorrahadan to'g'riga",
  arrive: 'Manzilga yetib keldingiz — yo\'l chetida to\'xtang',
  stop_here: "Yo'l chetiga to'xtang",
  seatbelt: 'Kamar',
  headlights: 'Faralar',
  gear: 'Uzatma',
  handbrake: "Qo'l tormozi",
  engine_stalled: "Dvigatel o'chdi — qayta yurgizish uchun I tugmasi",
  loading: 'Yuklanmoqda…',
  fps: 'FPS',
  cars: 'Mashinalar',
  avg_speed: "O'rtacha tezlik",
  lane_changes: 'Qayta tizilishlar',
  throughput: "O'tkazuvchanlik",
  webgpu_missing: "Bu qurilmada WebGPU mavjud emas. Chrome 113+ / Edge 113+ ishlating.",
  paused: 'Pauza',
  tip_belt: 'Harakatdan oldin kamarni taqing (B)',
  results: 'Natijalar',
  close: 'Yopish',
  camera: 'Kamera',
  regime_regulator: 'Tartibga soluvchi ishorasi',
  regime_light: 'Svetofor',
  regime_signs: 'Ustunlik belgilari',
  regime_equal: "Teng ahamiyatli (o'ng tomondagi ustun)",
  crash: "To'qnashuv!",
  ok: 'OK',
  version: 'Versiya',
};

const RU: Record<string, string> = {
  title: 'Автошахар',
  subtitle: '3D-симулятор вождения по городу по ПДД Республики Узбекистан',
  play_free: 'Свободная езда',
  play_missions: 'Задания (такси)',
  play_exam: 'Городской экзамен',
  play_spectate: 'Транспортный поток (наблюдатель)',
  gpu_bench: 'GPU-бенчмарк (WebGPU, 100 000 машин)',
  settings: 'Настройки',
  rules: 'Справочник ПДД',
  back: 'Назад',
  resume: 'Продолжить',
  restart: 'Заново',
  main_menu: 'Главное меню',
  car: 'Автомобиль',
  car_nexia2: 'Nexia 2 (механика, 5 ступеней)',
  car_cobalt_at: 'Cobalt (автомат, 6 ступеней)',
  language: 'Язык',
  quality: 'Качество графики',
  q_low: 'Низкое',
  q_medium: 'Среднее',
  q_high: 'Высокое',
  traffic_density: 'Плотность трафика',
  pedestrians: 'Пешеходы',
  time_of_day: 'Время суток',
  day: 'День',
  evening: 'Вечер',
  night: 'Ночь',
  weather: 'Погода',
  clear: 'Ясно',
  rain: 'Дождь',
  fog: 'Туман',
  lights_mode: 'Светофоры',
  lights_normal: 'Обычный режим',
  lights_flash: 'Мигающий жёлтый (ночной)',
  officer: 'Регулировщик (центральный перекрёсток)',
  on: 'Вкл',
  off: 'Выкл',
  transmission_auto: 'Автомат',
  clutch_mode: 'Сцепление механической КПП',
  clutch_assist: 'Ассистент сцепления (рекомендуется)',
  clutch_full: 'Полностью ручное управление',
  selector: 'Селектор',
  coach_title: 'Подготовьтесь к движению',
  coach_belt: 'B — пристегните ремень безопасности',
  coach_ready: 'Автомобиль готов к движению',
  coach_drive: 'W/↑ — газ, S/↓ — тормоз',
  coach_steer: 'A/D или ←/→ — руль',
  coach_manual: 'Z/X — передача −/+, Shift — сцепление',
  coach_selector: 'V — Drive, R — Reverse, N — Neutral, P — Park',
  clutch: 'Сцепление',
  stopped_fraction: 'Остановившиеся',
  reservations: 'Допуски перекрёстков',
  sound: 'Звук',
  controls: 'Управление',
  controls_text:
    'W/↑ — газ, S/↓ — тормоз, A/D или ←/→ — руль, Space — ручник, Q/E — поворотники, H — аварийка, L — фары, B — ремень, C — камера, Z/X — передача −/+ (механика), Shift — сцепление, V — Drive/1, R — Reverse, N — нейтраль, P — Park, I — двигатель, G — сигнал, M — карта, Esc — пауза. Поддерживается геймпад.',
  speed_limit: 'Ограничение скорости',
  penalty: 'Штраф',
  points: 'балл.',
  violations: 'Нарушения',
  no_violations: 'Нарушений нет — отлично!',
  score: 'Очки',
  money: 'сум',
  time: 'Время',
  distance: 'Дистанция',
  exam_passed: 'ЭКЗАМЕН СДАН',
  exam_failed: 'ЭКЗАМЕН НЕ СДАН',
  exam_intro:
    'Экзаменатор голосом указывает маршрут. Соблюдайте все требования ПДД. 20 и более штрафных баллов — экзамен не сдан.',
  mission_intro: 'Заберите пассажира и доставьте его по адресу без нарушений.',
  pickup: 'Заберите пассажира',
  dropoff: 'Доставьте по адресу',
  mission_done: 'Заказ выполнен',
  fare: 'Оплата',
  fine_total: 'Штрафы',
  next_turn_left: 'На следующем перекрёстке — налево',
  next_turn_right: 'На следующем перекрёстке — направо',
  next_straight: 'На следующем перекрёстке — прямо',
  arrive: 'Вы прибыли — остановитесь у обочины',
  stop_here: 'Остановитесь у края дороги',
  seatbelt: 'Ремень',
  headlights: 'Фары',
  gear: 'Передача',
  handbrake: 'Ручник',
  engine_stalled: 'Двигатель заглох — кнопка I для запуска',
  loading: 'Загрузка…',
  fps: 'FPS',
  cars: 'Машин',
  avg_speed: 'Средняя скорость',
  lane_changes: 'Перестроения',
  throughput: 'Пропускная способность',
  webgpu_missing: 'WebGPU недоступен на этом устройстве. Используйте Chrome 113+ / Edge 113+.',
  paused: 'Пауза',
  tip_belt: 'Пристегните ремень перед началом движения (B)',
  results: 'Результаты',
  close: 'Закрыть',
  camera: 'Камера',
  regime_regulator: 'Сигнал регулировщика',
  regime_light: 'Светофор',
  regime_signs: 'Знаки приоритета',
  regime_equal: 'Равнозначный (помеха справа)',
  crash: 'Столкновение!',
  ok: 'OK',
  version: 'Версия',
};

/** Uzbek Latin → Cyrillic (official 1995 alphabet correspondence). */
export function uzLatToCyr(s: string): string {
  const pairs: [RegExp, string][] = [
    // Word-initial E → Э must run while the text is still pure Latin
    // (JS \b is ASCII-only, Cyrillic letters would count as boundaries).
    [/\bE/g, 'Э'], [/\be/g, 'э'],
    [/O['‘’ʻ]/g, 'Ў'], [/o['‘’ʻ]/g, 'ў'],
    [/G['‘’ʻ]/g, 'Ғ'], [/g['‘’ʻ]/g, 'ғ'],
    [/Sh/g, 'Ш'], [/SH/g, 'Ш'], [/sh/g, 'ш'],
    [/Ch/g, 'Ч'], [/CH/g, 'Ч'], [/ch/g, 'ч'],
    [/Yo/g, 'Ё'], [/yo/g, 'ё'], [/Yu/g, 'Ю'], [/yu/g, 'ю'],
    [/Ya/g, 'Я'], [/ya/g, 'я'], [/Ye/g, 'Е'], [/ye/g, 'е'],
    [/['‘’ʻ]/g, 'ъ'],
  ];
  let r = s;
  for (const [a, b] of pairs) r = r.replace(a, b);
  const map: Record<string, string> = {
    A: 'А', B: 'Б', D: 'Д', E: 'Е', F: 'Ф', G: 'Г', H: 'Ҳ', I: 'И', J: 'Ж', K: 'К', L: 'Л', M: 'М', N: 'Н',
    O: 'О', P: 'П', Q: 'Қ', R: 'Р', S: 'С', T: 'Т', U: 'У', V: 'В', X: 'Х', Y: 'Й', Z: 'З',
    a: 'а', b: 'б', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'ҳ', i: 'и', j: 'ж', k: 'к', l: 'л', m: 'м', n: 'н',
    o: 'о', p: 'п', q: 'қ', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', x: 'х', y: 'й', z: 'з', c: 'с', w: 'в',
  };
  // Keep technical tokens (keys, sign numbers, WebGPU, FPS …) readable.
  return r.replace(/(\b[A-Z]{2,}[a-z]*\b|\b[A-Z]\/[A-Z]\b|\b[A-Z]\b(?= —)|WebGPU|Chrome|Edge|Nexia|Cobalt|Space|Shift|Esc)|([A-Za-z])/g,
    (m, keep, ch) => (keep ? keep : map[ch] ?? ch));
}

let current: Lang = (localStorage.getItem('avtoshahar.lang') as Lang) || 'uz_lat';
const cyrCache: Record<string, string> = {};

export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem('avtoshahar.lang', l);
  document.documentElement.lang = l === 'ru' ? 'ru' : 'uz';
}
export function getLang(): Lang {
  return current;
}

/** Translate a UI key. */
export function t(key: string): string {
  if (current === 'ru') return RU[key] ?? UZ[key] ?? key;
  const uz = UZ[key] ?? key;
  if (current === 'uz_cyr') return (cyrCache[key] ??= uzLatToCyr(uz));
  return uz;
}

/** Pick from a {uz, ru} text record (rules data). */
export function tr(text: { uz: string; ru: string }): string {
  if (current === 'ru') return text.ru;
  if (current === 'uz_cyr') return uzLatToCyr(text.uz);
  return text.uz;
}
