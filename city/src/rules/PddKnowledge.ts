// Knowledge base of the Road Traffic Rules of the Republic of Uzbekistan
// (Yo'l harakati qoidalari, YHQ — Vazirlar Mahkamasining qarori, lex.uz).
// Every sign used by the simulator is described here together with the way it
// modifies the autonomous agents (IDM/MOBIL parameters, lane-graph pruning,
// intersection priority) and the player's rule monitor.

export type SignGroup = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Txt {
  uz: string;
  ru: string;
}

export type SignShape = 'triangle' | 'triangle_down' | 'circle' | 'octagon' | 'diamond' | 'square' | 'rect' | 'plate';

export interface SignEffect {
  /** IDM desired speed cap (km/h). */
  speedLimit?: number;
  /** Multiplier on desired speed while approaching (warning signs). */
  v0Factor?: number;
  /** Intersection priority: main road / yield / mandatory stop. */
  priority?: 'main' | 'yield' | 'stop';
  /** MOBIL: lane change to the left forbidden. */
  noOvertake?: boolean;
  /** Allowed movements at the next junction (A* pruning, w = ∞ for others). */
  allowed?: Array<'straight' | 'left' | 'right' | 'uturn'>;
  /** Forbidden movements at the next junction. */
  forbidden?: Array<'straight' | 'left' | 'right' | 'uturn'>;
  /** Entry into the carriageway forbidden (one-way exit, 3.1). */
  noEntry?: boolean;
  /** Pedestrian crossing: activates the pedestrian scan cone. */
  pedestrianScan?: boolean;
  /** Stopping / parking restrictions (disabled drivers, mark 7.17, are exempt from 3.28). */
  noStopping?: boolean;
  noParking?: boolean;
  /** Informational routing hint (fuel, service, parking…). */
  poi?: 'parking' | 'service' | 'fuel' | 'hospital';
}

export interface SignDef {
  code: string;
  group: SignGroup;
  name: Txt;
  shape: SignShape;
  /** PNG from the Avtodrom art set (game/assets/signs), otherwise drawn. */
  file?: string;
  effect: SignEffect;
  /** Temporary signs (road works) are yellow and override permanent ones. */
  temporary?: boolean;
}

export const SIGN_GROUPS: Record<SignGroup, Txt> = {
  1: { uz: 'Ogohlantiruvchi belgilar', ru: 'Предупреждающие знаки' },
  2: { uz: 'Imtiyoz belgilari', ru: 'Знаки приоритета' },
  3: { uz: 'Taqiqlovchi belgilar', ru: 'Запрещающие знаки' },
  4: { uz: 'Buyuruvchi belgilar', ru: 'Предписывающие знаки' },
  5: { uz: "Axborot-ko'rsatkich belgilari", ru: 'Информационно-указательные знаки' },
  6: { uz: "Servis belgilari", ru: 'Знаки сервиса' },
  7: { uz: "Qo'shimcha axborot belgilari (lavhalar)", ru: 'Знаки дополнительной информации (таблички)' },
};

const S = (code: string, group: SignGroup, uz: string, ru: string, shape: SignShape, effect: SignEffect, file?: string, temporary?: boolean): SignDef => ({
  code, group, name: { uz, ru }, shape, effect, file, temporary,
});

/** Full catalogue of signs the city uses (and the reference screen shows). */
export const SIGNS: SignDef[] = [
  // 1. Warning — v0 reduced by 20-30 % in IDM, scan frequency increased.
  S('1.1', 1, "Shlagbaumli temir yo'l kesishmasi", 'Железнодорожный переезд со шлагбаумом', 'triangle', { v0Factor: 0.7 }, '1.1.png'),
  S('1.2', 1, "Shlagbaumsiz temir yo'l kesishmasi", 'Железнодорожный переезд без шлагбаума', 'triangle', { v0Factor: 0.7 }, '1.2.png'),
  S('1.8', 1, 'Svetofor bilan tartibga solinadigan chorraha', 'Светофорное регулирование', 'triangle', { v0Factor: 0.85 }),
  S('1.11.1', 1, 'Xavfli burilish (o\'ngga)', 'Опасный поворот направо', 'triangle', { v0Factor: 0.75 }, '1.11.1.png'),
  S('1.11.2', 1, 'Xavfli burilish (chapga)', 'Опасный поворот налево', 'triangle', { v0Factor: 0.75 }, '1.11.2.png'),
  S('1.20', 1, "Piyodalar o'tish joyi", 'Пешеходный переход', 'triangle', { v0Factor: 0.8, pedestrianScan: true }, '1.20.png'),
  S('1.21', 1, 'Bolalar', 'Дети', 'triangle', { v0Factor: 0.7, pedestrianScan: true }),
  S('1.23', 1, "Yo'l ishlari", 'Дорожные работы', 'triangle', { v0Factor: 0.7 }, undefined, true),
  // 2. Priority — edge weights / has_priority flag.
  S('2.1', 2, "Asosiy yo'l", 'Главная дорога', 'diamond', { priority: 'main' }, '2.1.png'),
  S('2.4', 2, "Yo'l bering", 'Уступите дорогу', 'triangle_down', { priority: 'yield' }, '2.4.png'),
  S('2.5', 2, "To'xtamasdan harakatlanish taqiqlangan", 'Движение без остановки запрещено', 'octagon', { priority: 'stop' }, '2.5.png'),
  // 3. Prohibitory — graph transitions blocked / physics limits.
  S('3.1', 3, 'Kirish taqiqlangan', 'Въезд запрещён', 'circle', { noEntry: true }, '3.1.png'),
  S('3.2', 3, 'Harakatlanish taqiqlangan', 'Движение запрещено', 'circle', { noEntry: true }, '3.2.png'),
  S('3.18.1', 3, "O'ngga burilish taqiqlanadi", 'Поворот направо запрещён', 'circle', { forbidden: ['right'] }, '3.18.1.png'),
  S('3.18.2', 3, 'Chapga burilish taqiqlanadi', 'Поворот налево запрещён', 'circle', { forbidden: ['left'] }, '3.18.2.png'),
  S('3.19', 3, 'Qayrilish taqiqlanadi', 'Разворот запрещён', 'circle', { forbidden: ['uturn'] }, '3.19.png'),
  S('3.20', 3, "Quvib o'tish taqiqlanadi", 'Обгон запрещён', 'circle', { noOvertake: true }, '3.20.png'),
  S('3.24-40', 3, 'Yuqori tezlik cheklangan (40)', 'Ограничение максимальной скорости (40)', 'circle', { speedLimit: 40 }, '3.24-40.png'),
  S('3.24-50', 3, 'Yuqori tezlik cheklangan (50)', 'Ограничение максимальной скорости (50)', 'circle', { speedLimit: 50 }),
  S('3.24-60', 3, 'Yuqori tezlik cheklangan (60)', 'Ограничение максимальной скорости (60)', 'circle', { speedLimit: 60 }),
  S('3.24-30T', 3, "Yuqori tezlik cheklangan (30, vaqtinchalik)", 'Ограничение скорости 30 (временный)', 'circle', { speedLimit: 30 }, undefined, true),
  S('3.25', 3, 'Tezlik cheklangan hududning oxiri', 'Конец ограничения максимальной скорости', 'circle', {}, '3.25.png'),
  S('3.27', 3, "To'xtash taqiqlangan", 'Остановка запрещена', 'circle', { noStopping: true }, '3.27.png'),
  S('3.28', 3, "To'xtab turish taqiqlangan", 'Стоянка запрещена', 'circle', { noParking: true }, '3.28.png'),
  // 4. Mandatory — A* pruning.
  S('4.1.1', 4, "Harakatlanish to'g'riga", 'Движение прямо', 'circle', { allowed: ['straight'] }, '4.1.1.png'),
  S('4.1.2', 4, "Harakatlanish o'ngga", 'Движение направо', 'circle', { allowed: ['right'] }, '4.1.2.png'),
  S('4.1.3', 4, 'Harakatlanish chapga', 'Движение налево', 'circle', { allowed: ['left', 'uturn'] }, '4.1.3.png'),
  S('4.1.4', 4, "To'g'riga yoki o'ngga", 'Движение прямо или направо', 'circle', { allowed: ['straight', 'right'] }, '4.1.4.png'),
  S('4.1.5', 4, "To'g'riga yoki chapga", 'Движение прямо или налево', 'circle', { allowed: ['straight', 'left', 'uturn'] }, '4.1.5.png'),
  S('4.1.6', 4, "O'ngga yoki chapga", 'Движение направо или налево', 'circle', { allowed: ['right', 'left', 'uturn'] }, '4.1.6.png'),
  S('4.2.1', 4, "To'siqni o'ngdan aylanib o'tish", 'Объезд препятствия справа', 'circle', {}, '4.2.1.png'),
  // 5. Information.
  S('5.5', 5, "Bir tomonlama harakatlanish yo'li", 'Дорога с односторонним движением', 'square', {}, '5.5.png'),
  S('5.15', 5, "To'xtab turish joyi", 'Место стоянки', 'square', { poi: 'parking' }, '5.15.png'),
  S('5.16.1', 5, "Piyodalar o'tish joyi", 'Пешеходный переход', 'square', { pedestrianScan: true }, '5.16.1.png'),
  S('5.16.2', 5, "Piyodalar o'tish joyi", 'Пешеходный переход', 'square', { pedestrianScan: true }, '5.16.2.png'),
  // 6. Service.
  S('6.4', 6, "Texnik xizmat ko'rsatish joyi", 'Техническое обслуживание автомобилей', 'rect', { poi: 'service' }, '6.4.png'),
  S('6.1', 6, 'Birinchi tibbiy yordam punkti', 'Пункт первой медицинской помощи', 'rect', { poi: 'hospital' }),
  S('6.7', 6, "Yoqilg'i quyish shoxobchasi", 'Автозаправочная станция', 'rect', { poi: 'fuel' }),
  // 7. Additional plates.
  S('7.2.1', 7, "Ta'sir oralig'i", 'Зона действия', 'plate', {}, '7.2.1.png'),
  S('7.13', 7, "Asosiy yo'lning yo'nalishi", 'Направление главной дороги', 'plate', {}, '7.13.png'),
  S('7.17', 7, 'Nogironlar (I–II guruh)', 'Инвалиды (I–II группы)', 'plate', {}),
];

export const SIGN_BY_CODE: Record<string, SignDef> = Object.fromEntries(SIGNS.map((s) => [s.code, s]));

/** Default speed limit in populated areas (YHQ, "Harakatlanish tezligi" bo'limi). */
export const CITY_SPEED_LIMIT = 70;

/**
 * Regulation hierarchy at a junction, highest first. The resolver in
 * TrafficRuleGraph walks this list and the first active source decides.
 */
export const CONTROL_HIERARCHY = ['regulator', 'light', 'temporary_sign', 'permanent_sign', 'marking', 'equal'] as const;
export type ControlSource = (typeof CONTROL_HIERARCHY)[number];

export type ViolationCode =
  | 'red_light'
  | 'regulator'
  | 'speeding'
  | 'speeding_major'
  | 'solid_line'
  | 'wrong_way'
  | 'oncoming_lane'
  | 'no_signal_turn'
  | 'no_signal_lane'
  | 'wrong_lane_turn'
  | 'forbidden_turn'
  | 'no_entry'
  | 'no_stop_sign'
  | 'yield'
  | 'pedestrian'
  | 'seatbelt'
  | 'headlights'
  | 'collision_car'
  | 'collision_ped'
  | 'collision_obj'
  | 'sidewalk'
  | 'stall';

export interface ViolationDef {
  code: ViolationCode;
  points: number;
  /** In-game fine (game currency). */
  fine: number;
  text: Txt;
  /** YHQ chapter the check is derived from. */
  rule: Txt;
  /** Ends the exam immediately. */
  critical?: boolean;
}

const V = (code: ViolationCode, points: number, fine: number, uz: string, ru: string, ruleUz: string, ruleRu: string, critical = false): ViolationDef => ({
  code, points, fine, text: { uz, ru }, rule: { uz: ruleUz, ru: ruleRu }, critical,
});

export const VIOLATIONS: Record<ViolationCode, ViolationDef> = {
  red_light: V('red_light', 20, 150000, "Svetoforning taqiqlovchi ishorasida o'tdi", 'Проезд на запрещающий сигнал светофора', 'Svetofor ishoralari', 'Сигналы светофора', true),
  regulator: V('regulator', 20, 150000, "Tartibga soluvchining taqiqlovchi ishorasida o'tdi", 'Проезд на запрещающий жест регулировщика', 'Tartibga soluvchining ishoralari', 'Сигналы регулировщика', true),
  speeding: V('speeding', 5, 40000, 'Tezlik cheklovi oshirildi', 'Превышение установленной скорости', 'Harakatlanish tezligi', 'Скорость движения'),
  speeding_major: V('speeding_major', 20, 200000, "Tezlik 20 km/soat dan ko'proq oshirildi", 'Превышение скорости более чем на 20 км/ч', 'Harakatlanish tezligi', 'Скорость движения', true),
  solid_line: V('solid_line', 10, 80000, "Yaxlit chiziq (1.1/1.3) kesib o'tildi", 'Пересечение сплошной линии разметки (1.1/1.3)', "Yo'l chiziqlari", 'Дорожная разметка'),
  wrong_way: V('wrong_way', 20, 250000, "Bir tomonlama yo'lda qarama-qarshi harakat", 'Движение во встречном направлении по дороге с односторонним движением', 'Belgi 5.5 / 3.1', 'Знаки 5.5 / 3.1', true),
  oncoming_lane: V('oncoming_lane', 20, 250000, "Qarama-qarshi harakat bo'lagiga chiqildi", 'Выезд на полосу встречного движения', "Transport vositalarining qatnov qismida joylashishi", 'Расположение ТС на проезжей части', true),
  no_signal_turn: V('no_signal_turn', 3, 20000, "Burilishda burilish ko'rsatkichi yoqilmadi", 'Не включён указатель поворота при повороте', 'Harakatlanishni boshlash va manevr qilish', 'Начало движения, маневрирование'),
  no_signal_lane: V('no_signal_lane', 3, 20000, "Qayta tizilishda burilish ko'rsatkichi yoqilmadi", 'Не включён указатель поворота при перестроении', 'Harakatlanishni boshlash va manevr qilish', 'Начало движения, маневрирование'),
  wrong_lane_turn: V('wrong_lane_turn', 5, 40000, "Burilishdan oldin tegishli chetki holat egallanmadi", 'Перед поворотом не занято крайнее положение', 'Harakatlanishni boshlash va manevr qilish', 'Начало движения, маневрирование'),
  forbidden_turn: V('forbidden_turn', 10, 80000, "Buyuruvchi/taqiqlovchi belgi talabi buzildi (4.1.x, 3.18, 3.19)", 'Нарушение требований знаков 4.1.x / 3.18 / 3.19', "Yo'l belgilari", 'Дорожные знаки'),
  no_entry: V('no_entry', 20, 250000, "3.1 «Kirish taqiqlangan» belgisi ostidan kirildi", 'Въезд под знак 3.1 «Въезд запрещён»', "Yo'l belgilari", 'Дорожные знаки', true),
  no_stop_sign: V('no_stop_sign', 10, 80000, "2.5 «STOP» belgisi oldida to'xtamadi", 'Не остановился перед знаком 2.5 «STOP»', "Yo'l belgilari", 'Дорожные знаки'),
  yield: V('yield', 20, 150000, "Chorrahada ustunlik huquqi berilmadi", 'Не уступил дорогу на перекрёстке', "Chorrahalardan o'tish", 'Проезд перекрёстков', true),
  pedestrian: V('pedestrian', 20, 150000, "Piyodalar o'tish joyida piyodaga yo'l berilmadi", 'Не уступил дорогу пешеходу на переходе', "Piyodalar o'tish joylari", 'Пешеходные переходы', true),
  seatbelt: V('seatbelt', 5, 40000, 'Xavfsizlik kamari taqilmagan', 'Не пристёгнут ремень безопасности', 'Haydovchining majburiyatlari', 'Обязанности водителя'),
  headlights: V('headlights', 3, 20000, "Qorong'ida/tumanda faralar yoqilmagan", 'Не включены фары в тёмное время / туман', 'Tashqi yoritish asboblari', 'Внешние световые приборы'),
  collision_car: V('collision_car', 20, 300000, "Transport vositasi bilan to'qnashuv", 'Столкновение с транспортным средством', "Yo'l-transport hodisasi", 'ДТП', true),
  collision_ped: V('collision_ped', 20, 500000, 'Piyodani urib yubordi', 'Наезд на пешехода', "Yo'l-transport hodisasi", 'ДТП', true),
  collision_obj: V('collision_obj', 10, 100000, "To'siqqa urildi", 'Наезд на препятствие', "Yo'l-transport hodisasi", 'ДТП'),
  sidewalk: V('sidewalk', 10, 80000, "Piyodalar yo'lkasida harakatlanish", 'Движение по тротуару', "Transport vositalarining qatnov qismida joylashishi", 'Расположение ТС на проезжей части'),
  stall: V('stall', 1, 0, "Dvigatel o'chib qoldi", 'Заглох двигатель', 'Imtihon talablari', 'Требования экзамена'),
};

/** Exam fails at this many points (city route). */
export const EXAM_FAIL_POINTS = 20;

/** IDM parameters per agent class (SI units). */
export const IDM_DEFAULTS = {
  a: 1.4, // max comfortable acceleration, m/s²
  b: 2.0, // comfortable deceleration, m/s²
  delta: 4,
  s0: 2.5, // jam distance, m
  T: 1.5, // time headway, s
  bSafe: 4.0, // MOBIL safety limit, m/s²
  politeness: 0.3,
  athreshold: 0.2,
  bias: 0.1, // keep-right bias (YHQ: occupy the rightmost free lane)
};

/** Weather modifies grip, headway and braking (7.x "Nam qoplama"). */
export const WEATHER_MODS: Record<'clear' | 'rain' | 'fog', { grip: number; T: number; b: number; view: number }> = {
  clear: { grip: 1.0, T: 1.0, b: 1.0, view: 1.0 },
  rain: { grip: 0.7, T: 1.35, b: 0.8, view: 0.75 },
  fog: { grip: 0.9, T: 1.5, b: 0.85, view: 0.35 },
};
