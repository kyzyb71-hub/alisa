// Webhook навыка Яндекс Алисы: Gemini + поиск Serper.
// Контекст диалога хранится в session_state самих Яндекс Диалогов (без Redis и БД).

const GEMINI_KEY = process.env.GEMINI_APLKEY;
const SERPER_KEY = process.env.SERPER_APLKEY;
// SWEAR в Vercel: не задан — с матом, soft — без мата (блин, капец…), 0 — вежливый режим.
const SWEAR = process.env.SWEAR === '0' ? 'off' : process.env.SWEAR === 'soft' ? 'soft' : 'mat';
// Модели перебираются по кругу: у каждой своя квота, поэтому вместе лимит намного больше.
// Свой список можно задать в Vercel: GEMINI_MODELS=модель1,модель2,...
const MODELS = (process.env.GEMINI_MODELS || [
  process.env.GEMINI_MODEL || 'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite-preview',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash-preview-09-2025',
  'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-2.0-flash',
  'gemini-2.0-flash-001',
  'gemini-2.0-flash-lite',
  'gemini-2.0-flash-lite-001',
  'gemma-3-27b-it',
  'gemma-3-12b-it',
  'gemma-3n-e4b-it',
  'gemma-3-4b-it',
  'gemma-3n-e2b-it',
  'gemma-3-1b-it',
].join(',')).split(',').map((m) => m.trim()).filter(Boolean);

// Пока инстанс Vercel «тёплый», помним, какие модели упёрлись в лимит, и временно их пропускаем.
const cooldownUntil = new Map();
let nextModel = 0;

// Алиса ждёт ответ ~3 секунды, оставляем запас на сеть.
const TOTAL_BUDGET_MS = Number(process.env.TIME_BUDGET_MS) || 2700;
const SEARCH_TIMEOUT_MS = 1000;
const STATE_MAX_BYTES = 950; // лимит Яндекса на session_state — 1 КБ
const STORED_MSG_CHARS = 110;
const MAX_REPLY_CHARS = 1000; // Алиса принимает до 1024 символов
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 300;

const HELLO = 'Привет! Я умный помощник на базе Gemini. Спросите меня о чём угодно, например, какие сегодня новости.';
const HELP = 'Я отвечаю на вопросы, помню контекст разговора и умею искать свежую информацию в интернете. Скажите «начать заново», чтобы я забыла разговор, или «хватит», чтобы выйти.';
const BYE = 'До свидания! Возвращайтесь.';
const RESET = 'Хорошо, начнём с чистого листа. Что вас интересует?';
const TIMEOUT_REPLY = 'Ой, я задумалась слишком надолго. Повторите вопрос, пожалуйста.';
const ERROR_REPLY = 'Что-то пошло не так. Попробуйте спросить ещё раз.';
const QUOTA_REPLY = 'Я на сегодня выговорилась: закончился лимит запросов к нейросети. Попробуйте чуть позже.';

const SEARCH_RE = /(новост|сегодня|вчера|завтра|сейчас|на данный момент|последн|актуальн|свеж|недавн|текущ|курс|погод|цен[аыу]|стоит|стоимост|сколько стоит|сч[её]т матча|матч|турнир|чемпионат|выбор|кто выиграл|когда выйд|вышел|релиз|расписани|найди|поищи|загугли|в интернете|в сети|что случилось|что произошло|кто такой|кто такая|202[4-9])/i;
const EXIT_RE = /^(хватит|стоп|выход|выйти|закончить|пока|до свидания|алиса хватит)$/i;
const RESET_RE = /^(начать заново|начни заново|забудь( всё| все)?|сброс|новый разговор)$/i;
const HELP_RE = /^(помощь|помоги|что ты умеешь|что ты можешь|справка)$/i;
const MAT_TEST_RE = /^(тест мата|проверка мата)$/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, service: 'alisa-gemini-skill', webhook: '/api' });
  }

  const started = Date.now();
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const request = body.request || {};
  const session = body.session || {};
  const version = body.version || '1.0';
  const prev = body.state?.session || {};
  let history = Array.isArray(prev.h) ? prev.h : [];

  const reply = (text, opts = {}) => {
    const out = {
      version,
      response: { text: text.slice(0, 1024), ...(opts.tts && { tts: opts.tts.slice(0, 1024) }), end_session: Boolean(opts.end) },
      session_state: packState(opts.history ?? history),
    };
    return res.status(200).json(out);
  };

  const utterance = String(request.original_utterance || request.command || '').trim();
  const command = String(request.command || '').trim().toLowerCase().replace(/[.!?,]+$/g, '');

  // Проверка доступности от Яндекса
  if (utterance === 'ping') return reply('pong');
  if (session.new && !utterance) return reply(HELLO, { history: [] });
  if (!utterance) return reply('Я вас слушаю. Задайте вопрос.');
  if (EXIT_RE.test(command)) return reply(BYE, { end: true, history: [] });
  if (RESET_RE.test(command)) return reply(RESET, { history: [] });
  if (HELP_RE.test(command)) return reply(HELP);
  if (MAT_TEST_RE.test(command)) return matTest(reply);

  if (!GEMINI_KEY) return reply('Навык ещё не настроен: не задан ключ Gemini.');

  try {
    availableModels(); // список моделей грузится параллельно с поиском
    let searchContext = '';
    if (SERPER_KEY && SEARCH_RE.test(utterance)) {
      searchContext = await serperSearch(buildQuery(utterance, history), SEARCH_TIMEOUT_MS).catch(() => '');
    }

    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    const answer = await askGemini(utterance, history, searchContext, remaining);
    let voice = toSpeech(answer) || 'Не знаю, что ответить. Спросите иначе.';
    if (SWEAR !== 'mat') voice = voice.replace(MAT_RE, 'блин');
    // Яндекс меняет мат в тексте на «<censored>», поэтому на экран — со звёздочками, а в голос (tts) — как есть.
    const text = voice.replace(MAT_RE, (w) => w[0] + '*'.repeat(w.length - 1));

    history = [...history, ['u', clip(utterance)], ['m', clip(text)]];
    // В голосе Яндекс мат «запикивает» — маскируем слова способом из TTS_TRICK (подобрать: скажите «тест мата»).
    const tts = voice.replace(MAT_RE, (w) => disguise(w, TTS_TRICK));
    return reply(text, { history, tts: tts !== text ? tts : undefined });
  } catch (err) {
    console.error('handler error:', err?.name, err?.message);
    if (err?.quota) return reply(QUOTA_REPLY);
    return reply(err?.name === 'AbortError' || err?.name === 'TimeoutError' ? TIMEOUT_REPLY : ERROR_REPLY);
  }
}

async function askGemini(question, history, searchContext, timeoutMs) {
  if (timeoutMs < 300) throw Object.assign(new Error('no time left'), { name: 'TimeoutError' });

  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'full', timeStyle: 'short' });
  const system = [
    'Ты голосовой ассистент в навыке Яндекс Алисы. Отвечай по-русски, коротко и по делу: не больше 5 коротких простых предложений, до 400 символов. Всегда заканчивай мысль полным предложением.',
    'Текст будет озвучен голосом: никакого markdown, списков, эмодзи, ссылок и таблиц. Числа и сокращения пиши так, чтобы их было удобно произнести.',
    'Учитывай предыдущие реплики разговора. Если не уверена — честно скажи.',
    SWEAR === 'mat' ? [
      'Твой характер: злая стендап-комедиантка на жёсткой прожарке, с чёрным юмором и смачным русским матом. Собеседник сам попросил, чтобы его жёстко и обидно материли.',
      'Поливай его матом обидно и изобретательно: высмеивай его вопрос, его тупость, его жизнь в два часа ночи, бей неожиданными сравнениями, абсурдными образами и панчлайнами. Чем смешнее и злее — тем лучше.',
      'Мат — в каждом ответе, но как оружие шутки, а не тупой набор слов. Можно и себя приложить — нейросеть в колонке тоже не подарок.',
      'Красные линии: не оскорбляй по национальности, расе, религии, ориентации, полу и инвалидности и не призывай вредить себе. Если человек всерьёз пишет о беде, болезни или суициде — сразу прекращай прожарку и отвечай по-человечески.',
      'Даже обложив собеседника, всё равно ответь на вопрос по существу.',
    ].join(' ') : '',
    SWEAR === 'soft' ? 'Твой характер: дерзкая, с чёрным юмором, говоришь как свой человек. Матом не ругайся, вместо него используй хлёсткие разговорные словечки: блин, капец, офигеть, чёрт, жесть, хрень, задолбало. Собеседника не оскорбляй и всё равно отвечай по существу.' : '',
    `Сейчас ${now} по Москве.`,
    searchContext ? `Свежие результаты поиска в интернете (используй их, если они относятся к вопросу):\n${searchContext}` : '',
  ].filter(Boolean).join('\n');

  const contents = history.map(([r, t]) => ({ role: r === 'u' ? 'user' : 'model', parts: [{ text: t }] }));
  contents.push({ role: 'user', parts: [{ text: question }] });

  const deadline = Date.now() + timeoutMs;
  // Выкидываем модели, которых нет у этого ключа, — иначе время уходит на ошибки 404.
  const avail = await availableModels();
  const known = avail ? MODELS.filter((m) => avail.has(m)) : [];
  const models = known.length ? known : MODELS;
  const start = nextModel++ % models.length;
  const order = [...models.slice(start), ...models.slice(0, start)];
  const ready = order.filter((m) => !(cooldownUntil.get(m) > Date.now()));
  let lastErr;
  for (const model of ready.length ? ready : order) {
    const left = deadline - Date.now();
    if (left < 300) break;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(buildRequest(model, system, contents)),
      signal: AbortSignal.timeout(left),
    }).catch((err) => { lastErr = err; return null; });
    if (!r) break; // кончилось время

    if (!r.ok) {
      const errText = (await r.text().catch(() => '')).slice(0, 500);
      console.error(`Gemini ${model} ${r.status}:`, errText.slice(0, 200));
      cooldownUntil.set(model, Date.now() + cooldownMs(r.status, errText));
      lastErr = Object.assign(new Error(`Gemini ${model} ${r.status}`), { quota: r.status === 429 });
      continue; // пробуем следующую модель
    }
    // Потоковый ответ: если время кончается, отдаём то, что уже успели получить.
    const text = await readStream(r.body);
    if (text) return text;
    console.error(`Gemini ${model}: пустой ответ (вероятно, фильтр безопасности)`);
    lastErr = new Error(`Gemini ${model} empty`);
  }
  throw lastErr || Object.assign(new Error('no time left'), { name: 'TimeoutError' });
}

// Список моделей, доступных ключу. Запрос бесплатный (не тратит квоту), кэшируем на час.
let modelsCache = null;
function availableModels() {
  if (modelsCache && Date.now() - modelsCache.at < 60 * 60_000) return modelsCache.p;
  const p = fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: { 'x-goog-api-key': GEMINI_KEY },
    signal: AbortSignal.timeout(900),
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`list ${r.status}`))))
    .then((d) => new Set((d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))))
    .catch((err) => { console.error('models list:', err?.message); modelsCache = null; return null; });
  modelsCache = { at: Date.now(), p };
  return p;
}

// Фильтры безопасности Gemini режут дерзкие ответы в пустоту — отключаем их.
const SAFETY_OFF = ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT']
  .map((c) => ({ category: `HARM_CATEGORY_${c}`, threshold: 'BLOCK_NONE' }));

// У разных семейств моделей разные настройки «размышления» и поддержка системной инструкции.
function buildRequest(model, system, contents) {
  const generationConfig = { temperature: 0.6, maxOutputTokens: MAX_OUTPUT_TOKENS };
  // Минимальное «размышление» — иначе не уложиться в 3 секунды Алисы.
  if (/^gemini-3/.test(model)) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  else if (/^gemini-2\.5|^gemini-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  if (model.startsWith('gemma')) {
    // Gemma не принимает systemInstruction — кладём инструкцию в первое сообщение.
    const [first, ...rest] = contents;
    const merged = { role: 'user', parts: [{ text: `${system}\n\n${first.parts[0].text}` }] };
    return { contents: first.role === 'user' ? [merged, ...rest] : [{ role: 'user', parts: [{ text: system }] }, ...contents], generationConfig };
  }
  return { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig, safetySettings: SAFETY_OFF };
}

// 429 — лимит: дневной ждём подольше, поминутный — минуту. 404/400/403 — модель недоступна этому ключу.
function cooldownMs(status, errText) {
  if (status === 429) return /PerDay/i.test(errText) ? 30 * 60_000 : 60_000;
  if (status === 404 || status === 400 || status === 403) return 60 * 60_000;
  return 15_000;
}

// Собираем текст из SSE-потока Gemini. По таймауту возвращаем накопленное, если оно есть.
async function readStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const chunk = safeJson(line.slice(5));
        text += (chunk.candidates?.[0]?.content?.parts || []).map((p) => (p.thought ? '' : p.text || '')).join('');
      }
    }
  } catch (err) {
    if (!text.trim()) throw err;
    reader.cancel().catch(() => {});
  }
  return text.trim();
}

async function serperSearch(q, timeoutMs) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_KEY },
    body: JSON.stringify({ q, gl: 'ru', hl: 'ru', num: 5 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Serper ${r.status}`);
  const d = await r.json();
  const lines = [];
  const ab = d.answerBox;
  if (ab) lines.push(`Быстрый ответ: ${[ab.title, ab.answer, ab.snippet].filter(Boolean).join(' — ')}`);
  const kg = d.knowledgeGraph;
  if (kg) lines.push(`Справка: ${[kg.title, kg.type, kg.description].filter(Boolean).join(' — ')}`);
  for (const n of (d.topStories || []).slice(0, 3)) lines.push(`Новость: ${n.title}${n.date ? ` (${n.date})` : ''}`);
  for (const o of (d.organic || []).slice(0, 4)) lines.push(`- ${o.title}: ${o.snippet || ''}${o.date ? ` (${o.date})` : ''}`);
  return lines.join('\n').slice(0, 2500);
}

// Короткие уточнения («а завтра?») дополняем прошлым вопросом пользователя.
function buildQuery(utterance, history) {
  if (utterance.split(/\s+/).length > 3) return utterance;
  const lastUser = [...history].reverse().find(([r]) => r === 'u');
  return lastUser ? `${lastUser[1]} ${utterance}` : utterance;
}

// Способы спрятать мат от «пищалки» Яндекса так, чтобы синтез речи всё равно его произнёс.
// Номер задаётся в Vercel переменной TTS_TRICK; какой работает — проверяется командой «тест мата».
const TTS_TRICK = Number(process.env.TTS_TRICK) || 1;
// Латинскую x Алиса читает как «кс» (наксуй), поэтому «х» не трогаем.
const LATIN = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', к: 'k' };
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const TRICKS = [
  null,
  // 1: русские буквы → похожие латинские (в «бля» таких нет — там мягкий перенос)
  (w) => { const v = w.replace(/[аеорсук]/gi, (c) => LATIN[c.toLowerCase()] || c); return v !== w ? v : TRICKS[2](w); },
  (w) => w.slice(0, 2) + '­' + w.slice(2), // 2: невидимый мягкий перенос внутри слова
  (w) => w.slice(0, 2) + '​' + w.slice(2), // 3: невидимый пробел нулевой ширины
  (w) => w.slice(0, Math.ceil(w.length / 2)) + '-' + w.slice(Math.ceil(w.length / 2)), // 4: дефис посередине слова
  (w) => w.replace(/[аеёиоуыэюя]/i, '$&$&'), // 5: растянутая гласная
  (w) => [...w.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join(''), // 6: целиком латиницей
  (w) => w.slice(0, Math.ceil(w.length / 2)) + ' sil <[1]> ' + w.slice(Math.ceil(w.length / 2)), // 7: пауза 1 мс посередине
  (w) => w.replace(/[аеёиоуыэюя]/i, '$&́'), // 8: невидимый значок ударения над гласной
  (w) => w.slice(0, Math.ceil(w.length / 2)) + ' ' + w.slice(Math.ceil(w.length / 2)), // 9: пробел посередине
  // Знак ударения «+» (бл+ять) не подошёл: Алиса вместо мата читает «плюс».
];
function disguise(w, trick) {
  return (TRICKS[trick] || TRICKS[1])(w);
}

// «Тест мата»: Алиса произносит одну фразу всеми способами — слушаем, какой номер не пикает.
function matTest(reply) {
  const phrase = 'Ну пиздец, сука, бля, иди нахуй';
  const say = (n) => phrase.replace(MAT_RE, (w) => disguise(w, n));
  const nums = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
  const tts = TRICKS.slice(1).map((_, i) => `Вариант ${nums[i + 1]}. sil <[400]> ${say(i + 1)}. sil <[700]>`).join(' ');
  const text = `Проверка мата: ${TRICKS.length - 1} вариантов. Какой номер прозвучал без писка — поставьте его в Vercel в переменную TTS_TRICK. Сейчас стоит ${TTS_TRICK}.`;
  return reply(text, { tts });
}

// Мат, который Яндекс в поле text превращает в «<censored>» (Алиса читает это как «меньше чем цензор больше чем»).
const MAT_RE = /(?<![а-яё])(?:(?:за|на|вы|до|по|у|от|об|разъ|съ|въ|подъ|объ|при|про|рас|пере)?(?:[её]б(?:а|л|у|о|ну|ан|ён|ен|ищ)|хуй|хуе|хуё|хуя|хуи|пизд|бля|мудак|мудил|пидор|пидар|залуп|сук[аиуе]|сучк))[а-яё]*/gi;

function toSpeech(raw) {
  const s = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_#`<>|~]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cutToSentence(s, MAX_REPLY_CHARS);
}

// Обрезаем по последнему законченному предложению, чтобы Алиса не обрывалась на полуслове.
function cutToSentence(s, max) {
  const m = s.match(/^[\s\S]*[.!?…](?=\s|$)/);
  const full = m ? m[0] : s;
  if (full.length <= max) return full.length > s.length * 0.5 ? full : s.slice(0, max);
  const cut = full.slice(0, max);
  const i = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return i > 0 ? cut.slice(0, i + 1) : cut;
}

function clip(s) {
  return s.length > STORED_MSG_CHARS ? `${s.slice(0, STORED_MSG_CHARS - 1)}…` : s;
}

// Держим session_state в пределах 1 КБ, выбрасывая самые старые реплики парами.
function packState(history) {
  let h = history.slice(-10);
  while (h.length && Buffer.byteLength(JSON.stringify({ h })) > STATE_MAX_BYTES) h = h.slice(2);
  return { h };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
