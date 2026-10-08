// Раздача витрин новых тем (design.md блока 5, В5-1 Б): метка хоста → указатель магазина → таблица раздачи его
// живой сборки → файл по отпечатку, переезд (301) или удалённое (410). Промах — список дорисовок, потом список адресов
// сущностей (В5-7 Б): адрес есть — рисовальщик (Св-1 В), нет — 404. Решения — в route.js, здесь только ввод-вывод
// nginx: подзапросы к кэшу хранилища (/_meta/, /_blob/) и к рисовальщику (/_draw), общая память (sf_routes), ответ.
// Таблица сборки не меняется, поэтому её строки один раз раскладываются в общую память и дальше ищутся по одному ключу.
import route from 'route.js';

const ROUTES = ngx.shared.sf_routes;
const RETRY_AFTER_SECONDS = '5';
const PAGE_TYPE = 'text/html; charset=utf-8';
const PAGES = {
  'not-found': { status: 404, text: 'Страница не найдена' },
  gone: { status: 410, text: 'Страница удалена' },
  unavailable: { status: 503, text: 'Магазин временно недоступен, попробуйте через минуту' },
};

function send(r, status, headers, body) {
  Object.entries(headers).forEach(([name, value]) => {
    r.headersOut[name] = value;
  });
  r.return(status, body);
}

function sendText(r, kind) {
  const page = PAGES[kind];
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' };
  if (page.status === 503) headers['Retry-After'] = RETRY_AFTER_SECONDS;
  send(r, page.status, headers, `${page.text}\n`);
}

// 404 и 410 — страницей 404 темы, если она есть в сборке; иначе встроенным текстом.
async function sendPage(r, meta, kind) {
  const uri = route.notFoundUri(meta);
  if (uri === null) return sendText(r, kind);
  const reply = await r.subrequest(uri);
  if (reply.status !== 200) return sendText(r, kind);
  send(r, route.PAGE_STATUS[kind], { 'Content-Type': PAGE_TYPE, 'Cache-Control': 'no-cache' }, reply.responseText);
}

async function readJson(r, key) {
  const reply = await r.subrequest(`/_meta/${key}`);
  if (reply.status === 404) return null;
  if (reply.status !== 200) throw new Error(`storefront: ${key} — хранилище ответило ${reply.status}`);
  return JSON.parse(reply.responseText);
}

// Метка «разложено» ставится последней: пока её нет, строки сборки раскладываются заново.
async function ensureTable(r, pointer) {
  const prefix = route.tablePrefix(pointer);
  if (route.isFresh(ROUTES.get(prefix + route.LOADED_KEY), Date.now())) return prefix;
  const table = await readJson(r, route.tableKey(pointer));
  if (table === null) throw new Error(`storefront: нет таблицы раздачи ${route.tableKey(pointer)}`);
  route.tableEntries(table, prefix).forEach(([key, value]) => ROUTES.set(key, value));
  ROUTES.set(prefix + route.LOADED_KEY, String(Date.now()));
  return prefix;
}

// Заголовки файла ставит фильтр /_blob/ (fileHeaders ниже): njs передаёт их через переменные запроса.
function sendFile(r, answer) {
  if (answer.kind === 'not-modified') return send(r, 304, answer.headers, '');
  r.variables.sf_type = answer.headers['Content-Type'];
  r.variables.sf_cache = answer.headers['Cache-Control'];
  r.variables.sf_etag = answer.headers.ETag;
  r.variables.sf_modified = answer.headers['Last-Modified'] ?? '';
  r.internalRedirect(answer.uri);
}

const SENDERS = {
  file: (r, meta, answer) => sendFile(r, answer),
  'not-modified': (r, meta, answer) => sendFile(r, answer),
  redirect: (r, meta, answer) => r.return(301, answer.location),
  gone: (r, meta) => sendPage(r, meta, 'gone'),
  'not-found': (r, meta) => sendPage(r, meta, 'not-found'),
};

const sendAnswer = (r, meta, answer) => SENDERS[answer.kind](r, meta, answer);

// Рисовальщик (Св-1 В): одинаковые промахи склеивает кэш /_draw, перебор сверх лимита — 503 (storefront.conf.template).
async function draw(r, pointer, meta) {
  const reply = await r.subrequest('/_draw', { args: route.drawArgs(pointer, meta, r.uri) });
  const answer = route.drawAnswer(reply.status);
  if (answer === 'unavailable') return sendText(r, answer);
  if (answer === 'not-found') return sendPage(r, meta, answer);
  send(r, 200, route.drawnHeaders(reply.headersOut['X-Merfy-Hash']), reply.responseText);
}

// Промах: адрес со «/» на конце есть — 301 туда; есть в списке дорисовок — файл; есть в списке адресов — рисуем.
async function miss(r, pointer, prefix, meta) {
  const slash = route.slashForm(r.uri);
  if (slash !== null && ROUTES.get(prefix + slash) !== undefined)
    return sendAnswer(r, meta, { kind: 'redirect', location: route.withArgs(slash, r.variables.args) });
  const drawn = route.drawnRow(await readJson(r, route.drawnKey(pointer)), r.uri);
  if (drawn !== null) return sendFile(r, route.fileAnswer(drawn, r.headersIn['If-None-Match']));
  if (!route.isListed(await readJson(r, route.entitiesKey(pointer)), r.uri)) return sendPage(r, meta, 'not-found');
  return draw(r, pointer, meta);
}

async function answer(r) {
  const raw = await readJson(r, route.pointerKey(r.variables.merfy_label));
  if (raw === null) return sendText(r, 'not-found');
  const pointer = route.checkPointer(raw);
  const prefix = await ensureTable(r, pointer);
  const meta = JSON.parse(ROUTES.get(prefix + route.META_KEY));
  const entry = ROUTES.get(prefix + r.uri);
  if (entry === undefined) return miss(r, pointer, prefix, meta);
  const request = { ifNoneMatch: r.headersIn['If-None-Match'], args: r.variables.args, now: Date.now() };
  return sendAnswer(r, meta, route.entryAnswer(JSON.parse(entry), request));
}

async function serve(r) {
  try {
    await answer(r);
  } catch (error) {
    r.error(String(error));
    sendText(r, 'unavailable');
  }
}

function fileHeaders(r) {
  r.headersOut['Content-Type'] = r.variables.sf_type;
  r.headersOut['Cache-Control'] = r.variables.sf_cache;
  r.headersOut.ETag = r.variables.sf_etag;
  r.headersOut['Last-Modified'] = r.variables.sf_modified || undefined;
}

// Сколько строк в общей памяти и сколько места осталось — для пробы и для дежурного.
function status(r) {
  const body = { keys: ROUTES.size(), freeBytes: ROUTES.freeSpace() };
  send(r, 200, { 'Content-Type': 'application/json' }, `${JSON.stringify(body)}\n`);
}

export default { serve, fileHeaders, status };
