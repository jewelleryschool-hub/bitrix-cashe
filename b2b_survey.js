// ============================================
// B2B ОПРОС: КУРС ПРОФЕССИОНАЛЬНОГО МОНТИРОВЩИКА
// Форма: GET  /b2b-survey
// Приём:  POST /b2b-survey/submit
// Ответы: GET  /b2b-survey/results?key=...
// ============================================

const NL = String.fromCharCode(10);

const SOURCE_ID = 'B2B_SURVEY';
const ASSIGNED_ID = 20326; // Кашинский
const PRIVACY_URL = 'https://jewelleryschool.com/';
const RESULTS_KEY = process.env.B2B_SURVEY_KEY || 'ijs-b2b-2026';

// Домены, с которых разрешено отправлять форму (страница может лежать не на этом сервере)
const ALLOWED_ORIGINS = (process.env.B2B_ALLOWED_ORIGINS ||
  'https://ask.b2b.jewelleryschool.com,https://b2b.jewelleryschool.com,https://jewelleryschool.com'
).split(',').map(function (s) { return s.trim(); }).filter(Boolean);

// Абсолютный адрес приёма для standalone-страницы
const SUBMIT_URL = process.env.B2B_SUBMIT_URL ||
  'https://bitrix-cashe-production.up.railway.app/b2b-survey/submit';

const SCALE6 = [
  'зависимость от одного-двух незаменимых монтировщиков',
  'срок ввода нового сотрудника в рабочий режим',
  'нестабильное качество между разными исполнителями',
  'высокие потери металла',
  'срыв сроков по сложным и срочным заказам',
  'невозможность взять заказ уровнем выше из-за отсутствия компетенции'
];

const PROGRAM_BLOCKS = [
  ['Основы конструкции и подготовка', [
    'чтение и оценка литья, дефекты отливки, брак и доработка',
    'подгонка и стыковка деталей, геометрия и симметрия',
    'допуски на усадку',
    'расчёт и контроль толщин стенок, прочность конструкции'
  ]],
  ['Пайка и соединение', [
    'припои по каратности и цвету, последовательность пайки',
    'тепловые режимы, защита от деформации и пережога',
    'пайка платины 950 и палладиевого белого золота',
    'лазерная сварка: режимы, применимость, ограничения',
    'пайка рядом с закреплёнными и термочувствительными камнями'
  ]],
  ['Узлы и механика', [
    'касты: посадка, юстировка, соосность',
    'замки серёг: английский, французский, пуссеты, итальянский, конго',
    'застёжки колье и браслетов, шарниры, петли',
    'трансформеры, съёмные элементы, механизмы'
  ]],
  ['Работа под оптикой', [
    'монтировка под микроскопом, микрогеометрия',
    'контроль швов и стыков при увеличении'
  ]],
  ['Финиш и контроль', [
    'предфинишная обработка, подготовка под полировку',
    'контроль веса и потерь металла',
    'ремонт и доработка после закрепки без повреждения камней',
    'критерии приёмки для сегмента премиум и люкс'
  ]]
];

function programRows() {
  const rows = [];
  PROGRAM_BLOCKS.forEach(function (b) {
    b[1].forEach(function (item) { rows.push(b[0] + ': ' + item); });
  });
  return rows;
}

const SCHEMA = [
  {
    id: 's0', title: 'Респондент',
    note: 'Ответы обрабатываются обезличенно. Сводный отчёт по отрасли пришлём всем участникам.',
    q: [
      { id: 'q1', n: 1, t: 'text', label: 'Компания', req: true },
      { id: 'q2', n: 2, t: 'text', label: 'Ваша должность', req: true },
      { id: 'q3', n: 3, t: 'text', label: 'Город, регион' },
      { id: 'q4', n: 4, t: 'text', label: 'Телефон или e-mail для обратной связи', req: true }
    ]
  },
  {
    id: 's1', title: 'Профиль производства',
    q: [
      { id: 'q5', n: 5, t: 'multi', label: 'Ценовой сегмент выпускаемой продукции', o: ['масс-маркет', 'средний', 'средний+', 'премиум', 'люкс', 'high jewellery, единичные авторские изделия'], req: true },
      { id: 'q6', n: 6, t: 'one', label: 'Объём выпуска в месяц, изделий', o: ['до 200', '200-1000', '1000-5000', 'свыше 5000'], req: true },
      { id: 'q7', n: 7, t: 'multi', label: 'Основные группы изделий', o: ['кольца', 'серьги', 'подвески и колье', 'браслеты', 'часовые корпуса и компоненты', 'трансформеры и сложные механики', 'другое'] },
      { id: 'q8', n: 8, t: 'multi', label: 'Металлы в работе', o: ['золото 585', 'золото 750', 'платина 950', 'палладиевое белое золото', 'серебро', 'комбинированные конструкции'] },
      { id: 'q9', n: 9, t: 'multi', label: 'Камни в работе', o: ['1-2 группа (бриллиант, сапфир, рубин)', 'изумруд', 'термочувствительные и органические (опал, жемчуг, бирюза)', 'полудрагоценные'] },
      { id: 'q10', n: 10, t: 'text', label: 'Численность производственного персонала: всего человек, и из них монтировщиков' }
    ]
  },
  {
    id: 's2', title: 'Участок монтировки сейчас',
    q: [
      { id: 'q11', n: 11, t: 'one', label: 'Сколько человек выполняет монтировочные операции', o: ['1', '2-3', '4-8', 'более 8'], req: true },
      { id: 'q12', n: 12, t: 'one', label: 'Средний стаж монтировщика в вашей компании', o: ['менее года', '1-3 года', '3-7 лет', 'более 7 лет'] },
      { id: 'q13', n: 13, t: 'multi', label: 'Оборудование участка', o: ['газовая горелка', 'водородный аппарат', 'лазерная сварка', 'импульсная (точечная) сварка', 'микроскоп или стереолупа на рабочем месте', 'бормашина с педалью'] },
      { id: 'q14', n: 14, t: 'one', label: 'Есть ли письменный стандарт монтировочных операций (допуски, толщины, посадочные места, режимы пайки)', o: ['да, действующий', 'формально есть, не соблюдается', 'нет'] },
      { id: 'q15', n: 15, t: 'one', label: 'Кто определяет допустимость изделия после монтировки', o: ['сам монтировщик', 'ОТК', 'технолог', 'закрепщик по факту приёмки', 'руководитель'] },
      { id: 'q16', n: 16, t: 'one', label: 'Согласованность между 3D, литьём, монтировкой и закрепкой (единые допуски и посадочные места)', o: ['да', 'частично', 'нет, каждый участок работает по своим представлениям'] }
    ]
  },
  {
    id: 's3', title: 'Потери и узкие места',
    q: [
      { id: 'q17', n: 17, t: 'one', label: 'Доля изделий, которые возвращаются на доработку после монтировки', o: ['менее 3%', '3-7%', '7-15%', 'более 15%', 'не считаем'], req: true },
      {
        id: 'q18', n: 18, t: 'multi', label: 'Основные причины возвратов и брака на монтировке (до трёх главных)', max: 3, o: [
          'деформация изделия при пайке, поведённая геометрия',
          'пережог, оплавление тонких элементов',
          'несоосность, перекос кастов, нарушение симметрии',
          'зазоры, непропаи, видимые швы',
          'посадочное места под детали не соответствует размеру',
          'повреждение уже закреплённых камней при доработке',
          'проблемы с замками серёг и застёжками, люфты',
          'потери металла выше нормы',
          'проблемы при работе с платиной и палладиевым белым золотом',
          'другое'
        ]
      },
      { id: 'q19', n: 19, t: 'one', label: 'Что происходит чаще', o: ['закрепщик переделывает за монтировщиком', 'монтировщик исправляет за литьём', 'оба варианта примерно поровну', 'системных переделок нет'] },
      { id: 'q20', n: 20, t: 'grid', label: 'Насколько критична каждая проблема (1 не проблема, 5 критично)', rows: SCALE6, req: true },
      { id: 'q21a', n: 21, t: 'one', label: 'Отказывались ли от заказов за последние два года из-за отсутствия монтировочной компетенции нужного уровня', o: ['да', 'нет'], req: true },
      { id: 'q21b', n: 21, t: 'area', label: 'Если да, кратко опишите' },
      { id: 'q22', n: 22, t: 'one', label: 'Во сколько обходятся переделки и брак на монтировке в месяц', o: ['до 100 тыс. руб.', '100-300 тыс.', '300-800 тыс.', 'свыше 800 тыс.', 'не считали'], req: true }
    ]
  },
  {
    id: 's4', title: 'Кадры и обучение',
    q: [
      { id: 'q23', n: 23, t: 'multi', label: 'Как закрываете потребность в монтировщиках', o: ['переманиваем готовых с рынка', 'растим внутри у наставника', 'берём выпускников училищ и колледжей', 'отправляем на внешнее обучение', 'не закрываем, дефицит'] },
      { id: 'q24', n: 24, t: 'one', label: 'Время вывода нового монтировщика на самостоятельную работу', o: ['до 3 месяцев', '3-6 месяцев', '6-12 месяцев', 'более года'] },
      { id: 'q25', n: 25, t: 'one', label: 'Сколько времени старший мастер тратит на наставничество вместо собственной выработки', o: ['менее 10%', '10-25%', '25-50%', 'более 50%'] },
      { id: 'q26', n: 26, t: 'one', label: 'Отправляли сотрудников на внешнее обучение за последние три года', o: ['да, регулярно', 'разово', 'нет'] },
      { id: 'q27', n: 27, t: 'area', label: 'Если отправляли: что не устроило в тех программах' },
      { id: 'q28', n: 28, t: 'one', label: 'Сколько человек готовы направить на обучение монтировке в ближайшие 12 месяцев', o: ['1-2', '3-5', '6-10', 'более 10', 'пока не готовы'], req: true }
    ]
  },
  {
    id: 's5', title: 'Содержание программы',
    note: 'Оцените важность каждого блока для вашего производства: 1 не нужно, 5 критично нужно.',
    q: [
      { id: 'q29', n: 29, t: 'grid', label: 'Важность тем', rows: programRows(), req: true },
      { id: 'q30', n: 30, t: 'area', label: 'Чего в этом списке не хватает под ваши задачи' },
      { id: 'q31', n: 31, t: 'area', label: 'Какая одна операция или узел вызывает больше всего проблем прямо сейчас' }
    ]
  },
  {
    id: 's6', title: 'Формат и логистика',
    q: [
      { id: 'q32', n: 32, t: 'one', label: 'Предпочтительный формат', o: [' длительное обучение на площадке школы в Санкт-Петербурге', 'смешанный: обучение в школе, отработка на месте, последующий аудит'], req: true },
      { id: 'q33', n: 33, t: 'one', label: 'Если смешанный формат: сможете предоставить оборудованное рабочее место в момент аудита', o: ['да, полностью', 'частично', 'нет'] },
      { id: 'q34', n: 34, t: 'one', label: 'Комфортная длительность', o: ['10 дней', '15 рабочих дней', '20 рабочих дней', 'модулями по нескольку недель с перерывами'] },
      { id: 'q35', n: 35, t: 'one', label: 'Приемлемо ли отсутствие сотрудника на производстве на весь срок обучения', o: ['да', 'только по одному-два человека за раз', 'только в низкий сезон', 'нет, нужен выезд к нам'] },
      { id: 'q36', n: 36, t: 'text', label: 'Низкий сезон вашего производства (месяцы)' },
      { id: 'q37', n: 37, t: 'one', label: 'Нужна ли итоговая аттестация с документом и объективной оценкой уровня', o: ['да, обязательно', 'желательно', 'не имеет значения'] },
      { id: 'q38', n: 38, t: 'one', label: 'Нужен ли аудит участка монтировки до обучения', o: ['да', 'возможно', 'нет'] }
    ]
  },
  {
    id: 's7', title: 'Бюджет и решение',
    q: [
      { id: 'q39', n: 39, t: 'one', label: 'Обоснованный бюджет на обучение одного монтировщика при измеримом снижении брака', o: ['до 150 тыс. руб.', '150-250 тыс.', '250-400 тыс.', 'свыше 400 тыс.', 'зависит от результата, готовы обсуждать'], req: true },
      { id: 'q40', n: 40, t: 'text', label: 'Индивидуальное обучение на нашей площадке: обоснованный бюджет на группу до 5 человек' },
      { id: 'q41', n: 41, t: 'one', label: 'Кто принимает решение о таком обучении', o: ['вы', 'собственник', 'финансовый директор', 'коллегиально'] },
      {
        id: 'q42', n: 42, t: 'multi', max: 3, label: 'Что должно быть в предложении для положительного решения (до трёх)', o: [
          'измеримые показатели до и после',
          'программа под конкретную номенклатуру нашего производства',
          'гарантия результата или доработка при недостижении',
          'рассрочка или поэтапная оплата',
          'рекомендации от сопоставимых предприятий'
        ]
      },
      { id: 'q43', n: 43, t: 'area', label: 'Что скорее оттолкнёт от такого предложения' }
    ]
  },
  {
    id: 's8', title: 'Готовность',
    q: [
      { id: 'q44', n: 44, t: 'one', label: 'Готовы участвовать в пилотном потоке с расширенной обратной связью и специальными условиями', o: ['да', 'возможно, при уточнении деталей', 'нет'], req: true },
      { id: 'q45', n: 45, t: 'one', label: 'Готовы к получасовому разговору с техническим руководителем школы', o: ['да', 'нет'], req: true },
      { id: 'q46', n: 46, t: 'area', label: 'С какими предприятиями вашего уровня рекомендуете также обсудить эту тему' }
    ]
  }
];

// ============================================
// СКОРИНГ
// ============================================
function scoreOf(a) {
  let s = 0;
  const m17 = { 'менее 3%': 0, '3-7%': 10, '7-15%': 20, 'более 15%': 25, 'не считаем': 8 };
  const m22 = { 'до 100 тыс. руб.': 3, '100-300 тыс.': 8, '300-800 тыс.': 15, 'свыше 800 тыс.': 20, 'не считали': 5 };
  const m28 = { '1-2': 5, '3-5': 10, '6-10': 15, 'более 10': 20, 'пока не готовы': 0 };
  const m39 = { 'до 100 тыс. руб.': 0, '100-200 тыс.': 5, '200-350 тыс.': 12, 'свыше 350 тыс.': 15, 'зависит от результата, готовы обсуждать': 10 };
  const m44 = { 'да': 10, 'возможно, при уточнении деталей': 5, 'нет': 0 };
  s += m17[a.q17] || 0;
  s += m22[a.q22] || 0;
  s += m28[a.q28] || 0;
  s += m39[a.q39] || 0;
  s += m44[a.q44] || 0;
  if (a.q21a === 'да') s += 10;
  const g = a.q20 || {};
  const vals = Object.keys(g).map(function (k) { return parseInt(g[k], 10) || 0; }).filter(function (v) { return v > 0; });
  if (vals.length) {
    const avg = vals.reduce(function (x, y) { return x + y; }, 0) / vals.length;
    s += Math.round((avg - 1) / 4 * 15);
  }
  return Math.min(100, s);
}

// ============================================
// ТЕКСТ ОТВЕТОВ ДЛЯ КОММЕНТАРИЯ ЛИДА
// ============================================
function answersToText(a) {
  const out = [];
  SCHEMA.forEach(function (step) {
    const lines = [];
    step.q.forEach(function (q) {
      const v = a[q.id];
      if (v === undefined || v === null || v === '') return;
      if (q.t === 'grid') {
        const rows = Object.keys(v).filter(function (k) { return v[k]; });
        if (!rows.length) return;
        rows.sort(function (x, y) { return (parseInt(v[y], 10) || 0) - (parseInt(v[x], 10) || 0); });
        lines.push(q.n + '. ' + q.label + ':');
        rows.forEach(function (k) { lines.push('   [' + v[k] + '] ' + k); });
      } else if (Array.isArray(v)) {
        if (!v.length) return;
        lines.push(q.n + '. ' + q.label + ': ' + v.join('; '));
      } else {
        lines.push(q.n + '. ' + q.label + ': ' + v);
      }
    });
    if (lines.length) out.push('=== ' + step.title + ' ===' + NL + lines.join(NL));
  });
  return out.join(NL + NL);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ============================================
// HTML ФОРМЫ
// ============================================
function pageHtml(submitUrl, fontsBase, logoUrl) {
  const submit = submitUrl || '/b2b-survey/submit';
  const ff = fontsBase ? fontFaces(fontsBase) : '';
  const brand = logoUrl
    ? '<img class="logo" src="' + logoUrl + '" alt="International Jewellery School">'
    : '<div class="brand">International Jewellery School</div>';
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>Исследование: подготовка монтировщиков для ювелирных производств</title>' +
    '<style>' + ff + CSS + '</style></head><body>' +
    '<div class="wrap">' +
    '<header class="hd">' + brand +
    '<h1>Подготовка монтировщиков для производств премиального сегмента</h1>' +
    '<p class="lead">Мы готовим программу подготовки монтировщиков и собираем требования от производств, чтобы курс отвечал реальным задачам цеха. Это не рассылка и не продажа. Ответы обрабатываются обезличенно, сводный отчёт по отрасли пришлём всем участникам. Заполнение занимает 8-10 минут.</p></header>' +
    '<div class="bar"><div class="bar-in" id="bar"></div></div>' +
    '<div class="step-label" id="steplabel"></div>' +
    '<form id="f" autocomplete="off"><div id="steps"></div>' +
    '<div class="hp"><label>Не заполняйте это поле<input type="text" id="website" name="website" tabindex="-1"></label></div>' +
    '<div class="consent" id="consentBox"><label class="chk"><input type="checkbox" id="consent"><span>Согласен на обработку персональных данных в соответствии с <a href="' + PRIVACY_URL + '" target="_blank" rel="noopener">политикой конфиденциальности</a></span></label></div>' +
    '<div class="nav"><button type="button" class="btn ghost" id="prev">Назад</button><button type="button" class="btn" id="next">Далее</button></div>' +
    '<div class="err" id="err"></div></form>' +
    '<div class="done" id="done"><h2>Спасибо</h2><p>Ответы получены. Если вы отметили готовность к разговору, свяжемся в ближайшие рабочие дни. Сводный отчёт по исследованию пришлём всем участникам.</p></div>' +
    '<footer class="ft">International Jewellery School, Санкт-Петербург, Дубай, Лиссабон</footer>' +
    '</div>' +
    '<script>const SCHEMA=' + JSON.stringify(SCHEMA) + ';var SUBMIT=' + JSON.stringify(submit) + ';' + JS + '<\/script></body></html>';
}

function fontFaces(base) {
  const b = String(base).replace(/\/$/, '');
  return [
    ['Evolventa', 'Evolventa-Regular.woff', 400],
    ['Inter', 'Inter-Regular.woff', 400],
    ['Inter', 'Inter-Medium.woff', 500],
    ['Inter', 'Inter-SemiBold.woff', 600]
  ].map(function (f) {
    return "@font-face{font-family:'" + f[0] + "';src:url('" + b + '/' + f[1] +
      "') format('woff'),local('" + f[0] + "');font-weight:" + f[2] + ';font-style:normal;font-display:swap}';
  }).join('');
}

const CSS = [
  ':root{--navy:#0F1C2E;--panel:#000000;--btn-dark:#1B293F;--gold:#AC8A5C;--golden:#D3BAA4;--sky:#D3BAA4;--line:#253142;--txt:#FFFFFF;--muted:#939393}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--navy);color:var(--txt);font-family:Inter,system-ui,sans-serif;font-size:16px;line-height:1.5;letter-spacing:-0.03em;overflow-wrap:break-word}',
  '.wrap{max-width:820px;margin:0 auto;padding:40px 20px 80px}',
  '.brand{font-size:13px;color:var(--gold);margin-bottom:22px}',
  '.logo{display:block;width:150px;height:auto;margin-bottom:26px}',
  'h1{font-family:Evolventa,Inter,sans-serif;font-weight:400;letter-spacing:-0.05em;font-size:clamp(24px,5vw,34px);line-height:1.1;margin:0 0 16px}',
  'h2{font-family:Evolventa,Inter,sans-serif;font-weight:400;letter-spacing:-0.05em;font-size:clamp(20px,4vw,26px);line-height:1.15;margin:0 0 18px}',
  '.lead{color:var(--muted);margin:0 0 30px;max-width:660px}',
  '.bar{height:2px;background:rgba(143,184,216,.18);margin-bottom:10px}',
  '.bar-in{height:2px;background:var(--gold);width:0;transition:width .25s}',
  '.step-label{font-size:13px;color:var(--muted);margin-bottom:26px}',
  '.step{display:none}.step.on{display:block}',
  '.step h2{color:#fff}',
  '.note{color:var(--muted);font-size:14px;margin:-8px 0 24px}',
  '.q{margin:0 0 30px;padding:0 0 26px;border-bottom:1px solid var(--line)}',
  '.q:last-child{border-bottom:none}',
  '.qlab{display:block;margin-bottom:12px;font-weight:500}',
  '.qnum{color:var(--gold);margin-right:8px}',
  '.req{color:var(--gold)}',
  '.hint{color:var(--muted);font-size:13px;margin-bottom:10px}',
  'input[type=text],textarea{width:100%;background:var(--panel);border:1px solid var(--line);color:var(--txt);padding:13px 15px;font:inherit;border-radius:4px}',
  'textarea{min-height:88px;resize:vertical}',
  'input[type=text]:focus,textarea:focus{outline:none;border-color:var(--gold)}',
  '.opts{display:flex;flex-direction:column;gap:8px}',
  '.opt{display:flex;align-items:flex-start;gap:10px;border:1px solid var(--line);padding:13px 15px;cursor:pointer;border-radius:4px;min-height:48px;background:var(--panel)}',
  '.opt.sel{border-color:var(--gold);background:var(--btn-dark)}',
  '.opt input{margin:3px 0 0}',
  '.grid{display:flex;flex-direction:column;gap:6px}',
  '.grow{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:9px 0;border-bottom:1px solid rgba(143,184,216,.1)}',
  '.gtxt{flex:1;font-size:14px}',
  '.gsc{display:flex;gap:6px;flex:0 0 auto}',
  '.gsc span{width:40px;height:40px;line-height:38px;text-align:center;border:1px solid var(--line);font-size:14px;cursor:pointer;border-radius:4px;background:var(--panel)}',
  '.gsc span.sel{border-color:var(--gold);background:var(--gold);color:var(--navy)}',
  '.gcap{display:flex;justify-content:flex-end;color:var(--muted);font-size:12px;margin-bottom:6px}',
  '.gblock{color:var(--gold);font-size:12px;letter-spacing:.08em;margin:20px 0 6px}',
  '.consent{display:none;margin:6px 0 20px;font-size:14px}',
  '.consent.on{display:block}',
  '.chk{display:flex;gap:10px;align-items:flex-start;color:var(--muted)}',
  '.chk a{color:var(--sky)}',
  '.nav{display:flex;gap:12px;margin-top:14px}',
  '.btn{background:var(--gold);color:var(--navy);border:none;padding:15px 30px;font:inherit;font-weight:500;letter-spacing:-0.05em;cursor:pointer;border-radius:4px;min-height:48px}',
  '.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}',
  '.btn[disabled]{opacity:.5;cursor:default}',
  '.err{color:#e2a2a2;font-size:14px;margin-top:14px;min-height:20px}',
  '.done{display:none;padding:40px 0}',
  '.done.on{display:block}',
  '.ft{margin-top:60px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}',
  '.hp{position:absolute;left:-9999px;top:-9999px}',
  '@media(max-width:640px){h1{font-size:24px}.wrap{padding:26px 16px 60px}.grow{flex-direction:column;align-items:flex-start;gap:8px}}'
].join('');

const JS = [
  'var A={};var cur=0;var steps=[];',
  'try{var sv=localStorage.getItem("ijs_b2b_draft");if(sv)A=JSON.parse(sv)||{};}catch(e){}',
  'function save(){try{localStorage.setItem("ijs_b2b_draft",JSON.stringify(A));}catch(e){}}',
  'function el(h){var d=document.createElement("div");d.innerHTML=h;return d.firstChild;}',
  'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
  'function build(){var host=document.getElementById("steps");',
  ' SCHEMA.forEach(function(st,si){var d=document.createElement("div");d.className="step";d.id=st.id;',
  '  var h="<h2>"+esc(st.title)+"</h2>";if(st.note)h+=\'<div class="note">\'+esc(st.note)+"</div>";d.innerHTML=h;',
  '  st.q.forEach(function(q){d.appendChild(renderQ(q));});host.appendChild(d);steps.push(d);});',
  ' show(0);}',
  'function renderQ(q){var w=document.createElement("div");w.className="q";w.dataset.qid=q.id;',
  ' var lab=\'<span class="qlab"><span class="qnum">\'+q.n+\'.</span>\'+esc(q.label)+(q.req?\' <span class="req">*</span>\':"")+"</span>";',
  ' w.innerHTML=lab;',
  ' if(q.max)w.appendChild(el(\'<div class="hint">Не более \'+q.max+" вариантов</div>"));',
  ' if(q.t==="text"){var i=document.createElement("input");i.type="text";i.value=A[q.id]||"";i.oninput=function(){A[q.id]=i.value;save();};w.appendChild(i);}',
  ' else if(q.t==="area"){var t=document.createElement("textarea");t.value=A[q.id]||"";t.oninput=function(){A[q.id]=t.value;save();};w.appendChild(t);}',
  ' else if(q.t==="one"||q.t==="multi"){var box=document.createElement("div");box.className="opts";',
  '  q.o.forEach(function(o){var b=document.createElement("label");b.className="opt";',
  '   var inp=document.createElement("input");inp.type=(q.t==="one"?"radio":"checkbox");inp.name=q.id;inp.value=o;',
  '   var sp=document.createElement("span");sp.textContent=o;b.appendChild(inp);b.appendChild(sp);',
  '   if(q.t==="one"&&A[q.id]===o){inp.checked=true;b.className="opt sel";}',
  '   if(q.t==="multi"&&(A[q.id]||[]).indexOf(o)>=0){inp.checked=true;b.className="opt sel";}',
  '   inp.onchange=function(){if(q.t==="one"){A[q.id]=o;Array.prototype.forEach.call(box.children,function(c){c.className="opt";});b.className="opt sel";}',
  '    else{var arr=A[q.id]||[];if(inp.checked){if(q.max&&arr.length>=q.max){inp.checked=false;return;}arr=arr.concat([o]);}else{arr=arr.filter(function(x){return x!==o;});}A[q.id]=arr;b.className=inp.checked?"opt sel":"opt";}save();};',
  '   box.appendChild(b);});w.appendChild(box);}',
  ' else if(q.t==="grid"){A[q.id]=A[q.id]||{};var g=document.createElement("div");g.className="grid";',
  '  w.appendChild(el(\'<div class="gcap">1 &nbsp; 2 &nbsp; 3 &nbsp; 4 &nbsp; 5</div>\'));',
  '  var lastb="";',
  '  q.rows.forEach(function(r){var parts=r.split(": ");var bl=parts.length>1?parts[0]:"";var txt=parts.length>1?parts.slice(1).join(": "):r;',
  '   if(bl&&bl!==lastb){lastb=bl;g.appendChild(el(\'<div class="gblock">\'+esc(bl)+"</div>"));}',
  '   var row=document.createElement("div");row.className="grow";row.appendChild(el(\'<div class="gtxt">\'+esc(txt)+"</div>"));',
  '   var sc=document.createElement("div");sc.className="gsc";',
  '   [1,2,3,4,5].forEach(function(v){var s=document.createElement("span");s.textContent=v;',
  '    if(String(A[q.id][r])===String(v))s.className="sel";',
  '    s.onclick=function(){A[q.id][r]=v;Array.prototype.forEach.call(sc.children,function(c){c.className="";});s.className="sel";save();};sc.appendChild(s);});',
  '   row.appendChild(sc);g.appendChild(row);});w.appendChild(g);}',
  ' return w;}',
  'function show(i){cur=i;steps.forEach(function(s,k){s.className=k===i?"step on":"step";});',
  ' document.getElementById("bar").style.width=Math.round((i)/(steps.length-1)*100)+"%";',
  ' document.getElementById("steplabel").textContent="Шаг "+(i+1)+" из "+steps.length;',
  ' document.getElementById("prev").style.display=i===0?"none":"inline-block";',
  ' var last=i===steps.length-1;document.getElementById("next").textContent=last?"Отправить":"Далее";',
  ' document.getElementById("consentBox").className=last?"consent on":"consent";',
  ' document.getElementById("err").textContent="";window.scrollTo(0,0);}',
  'function valid(){var st=SCHEMA[cur];var bad=null;',
  ' st.q.forEach(function(q){if(bad||!q.req)return;var v=A[q.id];',
  '  if(q.t==="grid"){var n=Object.keys(v||{}).length;if(n<q.rows.length)bad="Оцените все строки в вопросе "+q.n;}',
  '  else if(q.t==="multi"){if(!v||!v.length)bad="Ответьте на вопрос "+q.n;}',
  '  else if(!v||!String(v).trim())bad="Ответьте на вопрос "+q.n;});',
  ' return bad;}',
  'document.getElementById("prev").onclick=function(){if(cur>0)show(cur-1);};',
  'document.getElementById("next").onclick=function(){var bad=valid();',
  ' if(bad){document.getElementById("err").textContent=bad;return;}',
  ' if(cur<steps.length-1){show(cur+1);return;}',
  ' if(!document.getElementById("consent").checked){document.getElementById("err").textContent="Отметьте согласие на обработку данных";return;}',
  ' send();};',
  'function send(){var b=document.getElementById("next");b.disabled=true;b.textContent="Отправляем";',
  ' var payload={answers:A,website:document.getElementById("website").value,url:location.href,ref:document.referrer,src:(new URLSearchParams(location.search).get("src")||"")};',
  ' fetch(SUBMIT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})',
  '  .then(function(r){return r.json();}).then(function(r){',
  '   if(r&&r.ok){try{localStorage.removeItem("ijs_b2b_draft");}catch(e){}',
  '    document.getElementById("f").style.display="none";document.querySelector(".bar").style.display="none";',
  '    document.getElementById("steplabel").style.display="none";document.getElementById("done").className="done on";window.scrollTo(0,0);}',
  '   else{b.disabled=false;b.textContent="Отправить";document.getElementById("err").textContent="Не удалось отправить. Попробуйте ещё раз.";}})',
  '  .catch(function(){b.disabled=false;b.textContent="Отправить";document.getElementById("err").textContent="Нет связи с сервером. Попробуйте ещё раз.";});}',
  'build();'
].join('');

// ============================================
// MOUNT
// ============================================
function mount(app, deps) {
  const WEBHOOK = deps.WEBHOOK;
  const fetchFn = deps.fetch || fetch;
  const pgPool = deps.pgPool || null;

  if (pgPool) {
    pgPool.query('CREATE TABLE IF NOT EXISTS b2b_survey (id SERIAL PRIMARY KEY, created_at BIGINT NOT NULL, lead_id INT, score INT, company TEXT, payload JSONB NOT NULL)')
      .then(function () { console.log('✓ Таблица b2b_survey готова'); })
      .catch(function (e) { console.log('⚠️ b2b_survey table:', e.message); });
  }

  // CORS: страница может быть размещена на отдельном домене
  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.indexOf(origin) >= 0) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.set('Access-Control-Max-Age', '86400');
      return true;
    }
    return false;
  }

  app.options('/b2b-survey/submit', function (req, res) {
    if (cors(req, res)) return res.status(204).end();
    res.status(403).end();
  });

  app.get('/b2b-survey', function (req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8').send(pageHtml());
  });

  // Готовая страница с абсолютным адресом приёма, для размещения на своём домене
  app.get('/b2b-survey/standalone', function (req, res) {
    res.set('Content-Type', 'text/html; charset=utf-8').send(pageHtml(SUBMIT_URL));
  });

  app.post('/b2b-survey/submit', async function (req, res) {
    cors(req, res);
    try {
      const body = req.body || {};
      if (body.website) return res.json({ ok: true }); // ханипот
      const a = body.answers || {};
      if (!a.q1 || !a.q4) return res.status(400).json({ ok: false, error: 'нет компании или контакта' });

      const score = scoreOf(a);
      const src = String(body.src || '').slice(0, 40).replace(/[^a-zA-Z0-9_\-]/g, '');
      const company = String(a.q1).slice(0, 200);
      const contact = String(a.q4).trim();
      const isEmail = contact.indexOf('@') > 0;
      const digits = contact.replace(/[^0-9+]/g, '');

      const fields = {
        TITLE: 'B2B монтировка: ' + company + ' (скор ' + score + ')',
        NAME: company,
        COMPANY_TITLE: company,
        POST: String(a.q2 || '').slice(0, 200),
        SOURCE_ID: SOURCE_ID,
        SOURCE_DESCRIPTION: 'Опрос B2B: курс монтировщика' + (src ? ' (переход: ' + src + ')' : ''),
        ASSIGNED_BY_ID: ASSIGNED_ID,
        OPENED: 'Y',
        ADDRESS_CITY: String(a.q3 || '').slice(0, 100),
        COMMENTS: 'СКОРИНГ ПОТРЕБНОСТИ: ' + score + ' из 100' + NL + NL + answersToText(a)
      };
      if (isEmail) fields.EMAIL = [{ VALUE: contact, VALUE_TYPE: 'WORK' }];
      else if (digits.length >= 6) fields.PHONE = [{ VALUE: contact, VALUE_TYPE: 'WORK' }];
      else fields.COMMENTS = 'Контакт: ' + contact + NL + fields.COMMENTS;

      let leadId = null;
      try {
        const r = await fetchFn(WEBHOOK + '/crm.lead.add.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fields, params: { REGISTER_SONET_EVENT: 'Y' } }),
          timeout: 20000
        });
        const j = await r.json();
        leadId = j.result || null;
        if (!leadId) console.log('⚠️ b2b-survey lead.add:', JSON.stringify(j).slice(0, 300));
      } catch (e) {
        console.log('⚠️ b2b-survey lead.add error:', e.message);
      }

      // В портале работает автораспределение лидов, оно перебивает ASSIGNED_BY_ID при создании.
      // Возвращаем ответственного отдельным вызовом.
      if (leadId) {
        try {
          await fetchFn(WEBHOOK + '/crm.lead.update.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: leadId, fields: { ASSIGNED_BY_ID: ASSIGNED_ID } }),
            timeout: 15000
          });
        } catch (e) { console.log('⚠️ b2b-survey assign fix:', e.message); }
      }

      if (pgPool) {
        try {
          await pgPool.query('INSERT INTO b2b_survey(created_at, lead_id, score, company, payload) VALUES($1,$2,$3,$4,$5)',
            [Date.now(), leadId, score, company, JSON.stringify({ answers: a, url: body.url || '', ref: body.ref || '' })]);
        } catch (e) { console.log('⚠️ b2b_survey insert:', e.message); }
      }

      res.json({ ok: true, lead: leadId, score: score });
    } catch (e) {
      console.log('⚠️ b2b-survey submit:', e.message);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // Заявка с B2B-лендинга (форма «Получить консультацию»)
  app.options('/b2b-lead', function (req, res) {
    if (cors(req, res)) return res.status(204).end();
    res.status(403).end();
  });

  app.post('/b2b-lead', async function (req, res) {
    cors(req, res);
    try {
      const b = req.body || {};
      if (b.website) return res.json({ ok: true }); // ханипот
      const name = String(b.name || '').trim().slice(0, 200);
      const contact = String(b.contact || '').trim().slice(0, 200);
      const company = String(b.company || '').trim().slice(0, 200);
      if (!name || !contact) return res.status(400).json({ ok: false, error: 'нет имени или контакта' });

      const isEmail = contact.indexOf('@') > 0;
      const digits = contact.replace(/[^0-9+]/g, '');
      const fields = {
        TITLE: 'B2B лендинг: ' + (company || name),
        NAME: name,
        SOURCE_ID: 'B2B_LANDING',
        SOURCE_DESCRIPTION: 'Лендинг b2b.jewelleryschool.com, форма консультации',
        ASSIGNED_BY_ID: ASSIGNED_ID,
        OPENED: 'Y',
        COMMENTS: 'Страница: ' + String(b.page || '').slice(0, 300)
      };
      if (company) fields.COMPANY_TITLE = company;
      if (isEmail) fields.EMAIL = [{ VALUE: contact, VALUE_TYPE: 'WORK' }];
      else if (digits.length >= 6) fields.PHONE = [{ VALUE: contact, VALUE_TYPE: 'WORK' }];
      else fields.COMMENTS = 'Контакт: ' + contact + NL + fields.COMMENTS;

      let leadId = null;
      try {
        const r = await fetchFn(WEBHOOK + '/crm.lead.add.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: fields, params: { REGISTER_SONET_EVENT: 'Y' } }),
          timeout: 20000
        });
        const j = await r.json();
        leadId = j.result || null;
        if (!leadId) console.log('⚠️ b2b-lead lead.add:', JSON.stringify(j).slice(0, 300));
      } catch (e) { console.log('⚠️ b2b-lead lead.add error:', e.message); }

      if (leadId) {
        try {
          await fetchFn(WEBHOOK + '/crm.lead.update.json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: leadId, fields: { ASSIGNED_BY_ID: ASSIGNED_ID } }),
            timeout: 15000
          });
        } catch (e) { console.log('⚠️ b2b-lead assign fix:', e.message); }
      }

      res.json({ ok: true, lead: leadId });
    } catch (e) {
      console.log('⚠️ b2b-lead:', e.message);
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.get('/b2b-survey/results', async function (req, res) {
    if (req.query.key !== RESULTS_KEY) return res.status(403).send('нет доступа');
    if (!pgPool) return res.status(500).send('Postgres недоступен');
    try {
      const r = await pgPool.query('SELECT id, created_at, lead_id, score, company, payload FROM b2b_survey ORDER BY id DESC');
      const rows = r.rows || [];
      if (req.query.format === 'json') return res.json(rows);
      let h = '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>B2B опрос: ответы</title>' +
        '<style>body{background:#0e1c2e;color:#e8eef5;font-family:Inter,system-ui,sans-serif;padding:30px}' +
        'h1{font-weight:400;font-size:22px}table{border-collapse:collapse;width:100%;font-size:13px}' +
        'th,td{border:1px solid rgba(143,184,216,.22);padding:8px 10px;text-align:left;vertical-align:top}' +
        'th{color:#c2a25c;font-weight:500}pre{white-space:pre-wrap;font:inherit;margin:0;color:#9fb2c6}' +
        'details summary{cursor:pointer;color:#8fb8d8}</style></head><body>';
      h += '<h1>Ответы: ' + rows.length + '</h1><table><tr><th>#</th><th>Дата</th><th>Компания</th><th>Скор</th><th>Лид</th><th>Ответы</th></tr>';
      rows.forEach(function (x) {
        const p = typeof x.payload === 'string' ? JSON.parse(x.payload) : x.payload;
        h += '<tr><td>' + x.id + '</td><td>' + new Date(Number(x.created_at)).toLocaleString('ru-RU') + '</td>' +
          '<td>' + esc(x.company) + '</td><td>' + x.score + '</td>' +
          '<td>' + (x.lead_id ? '<a style="color:#8fb8d8" href="https://b24-99blai.bitrix24.ru/crm/lead/details/' + x.lead_id + '/" target="_blank">' + x.lead_id + '</a>' : 'нет') + '</td>' +
          '<td><details><summary>показать</summary><pre>' + esc(answersToText(p.answers || {})) + '</pre></details></td></tr>';
      });
      h += '</table></body></html>';
      res.set('Content-Type', 'text/html; charset=utf-8').send(h);
    } catch (e) {
      res.status(500).send('ошибка: ' + e.message);
    }
  });
}

module.exports = { mount: mount, pageHtml: pageHtml, SUBMIT_URL: SUBMIT_URL, SCHEMA: SCHEMA, scoreOf: scoreOf, answersToText: answersToText };
