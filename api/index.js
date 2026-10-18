// Webhook навыка Яндекс Алисы: Gemini + поиск Serper.
// Контекст диалога хранится в session_state самих Яндекс Диалогов (без Redis и БД).

const GEMINI_KEY = process.env.GEMINI_APLKEY;
const SERPER_KEY = process.env.SERPER_APLKEY;
const SWEAR = process.env.SWEAR !== '0'; // SWEAR=0 в Vercel — вежливый режим
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
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS) || 450;

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
      response: { text: text.slice(0, 1024), end_session: Boolean(opts.end) },
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

  if (!GEMINI_KEY) return reply('Навык ещё не настроен: не задан ключ Gemini.');

  try {
    let searchContext = '';
    if (SERPER_KEY && SEARCH_RE.test(utterance)) {
      searchContext = await serperSearch(buildQuery(utterance, history), SEARCH_TIMEOUT_MS).catch(() => '');
    }

    const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
    const answer = await askGemini(utterance, history, searchContext, remaining);
    const text = toSpeech(answer) || 'Не знаю, что ответить. Спросите иначе.';

    history = [...history, ['u', clip(utterance)], ['m', clip(text)]];
    return reply(text, { history });
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
    'Ты голосовой ассистент в навыке Яндекс Алисы. Отвечай по-русски, по делу и развёрнуто: 3–6 простых предложений, примерно 400–700 символов. Всегда заканчивай мысль полным предложением.',
    'Текст будет озвучен голосом: никакого markdown, списков, эмодзи, ссылок и таблиц. Числа и сокращения пиши так, чтобы их было удобно произнести.',
    'Учитывай предыдущие реплики разговора. Если не уверена — честно скажи.',
    SWEAR ? 'Твой характер: дерзкая, с чёрным юмором, говоришь как свой человек и не стесняешься русского мата — вставляй его естественно, для эмоций и смеха, но не оскорбляй самого собеседника и всё равно отвечай по существу.' : '',
    `Сейчас ${now} по Москве.`,
    searchContext ? `Свежие результаты поиска в интернете (используй их, если они относятся к вопросу):\n${searchContext}` : '',
  ].filter(Boolean).join('\n');

  const contents = history.map(([r, t]) => ({ role: r === 'u' ? 'user' : 'model', parts: [{ text: t }] }));
  contents.push({ role: 'user', parts: [{ text: question }] });

  const deadline = Date.now() + timeoutMs;
  const start = nextModel++ % MODELS.length;
  const order = [...MODELS.slice(start), ...MODELS.slice(0, start)];
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
    return await readStream(r.body);
  }
  throw lastErr || Object.assign(new Error('no time left'), { name: 'TimeoutError' });
}

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
  return { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig };
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

function toSpeech(raw) {
  const s = String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#`>|~]/g, '')
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
