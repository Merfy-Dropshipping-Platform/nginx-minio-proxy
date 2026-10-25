// Раздача витрин новых тем (design.md блока 5, В5-1 Б): метка хоста → указатель магазина → таблица раздачи его
// живой сборки → файл по отпечатку, переезд (301) или удалённое (410). Страница со списком с параметрами списка —
// рисовальщик с ними (блок 11). Промах — список дорисовок, потом список адресов
// сущностей (В5-7 Б): адрес есть — рисовальщик (Св-1 В), нет — 404. Решения — в route.js, здесь только ввод-вывод
// nginx: подзапросы к кэшу хранилища (/_meta/, /_blob/) и к рисовальщику (/_draw), общая память (sf_routes), ответ.
// Таблица сборки не меняется, поэтому её строки один раз раскладываются в общую память и дальше ищутся по одному ключу.
import route from 'route.js';

const ROUTES = ngx.shared.sf_routes;
// Копии страниц 502 магазинов (часть 7а): ключ — метка хоста.
const UNAVAILABLE = ngx.shared.sf_unavailable;
const RETRY_AFTER_SECONDS = '5';
const PAGE_TYPE = 'text/html; charset=utf-8';
const PAGES = {
  'not-found': { status: 404, text: 'Страница не найдена' },
  gone: { status: 410, text: 'Страница удалена' },
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
  send(r, page.status, headers, `${page.text}\n`);
}

// 503 «временно недоступно» (часть 7а): копия 502.html магазина, её нет — нейтральная страница платформы.
function sendUnavailable(r) {
  const headers = { 'Content-Type': PAGE_TYPE, 'Cache-Control': 'no-cache', 'Retry-After': RETRY_AFTER_SECONDS };
  send(r, 503, headers, route.keptHtml(UNAVAILABLE.get(r.variables.merfy_label)));
}

// Копия 502.html читается, когда таблица сборки раскладывается в память. Сбой копии раздачу не останавливает: строка в
// журнал, прежняя копия остаётся. В таблице копии нет — копия магазина удаляется.
async function keepUnavailable(r, table) {
  const label = r.variables.merfy_label;
  const hash = route.unavailableHash(table);
  try {
    if (hash === null) {
      UNAVAILABLE.delete(label);
      return;
    }
    if (route.isKept(UNAVAILABLE.get(label), hash)) return;
    const reply = await r.subrequest(route.textUri(hash));
    if (reply.status !== 200) {
      r.warn(`storefront: копия 502 ${hash} — хранилище ответило ${reply.status}`);
      return;
    }
    UNAVAILABLE.set(label, route.keptValue(hash, reply.responseText));
  } catch (error) {
    r.warn(`storefront: копия 502 — ${String(error)}`);
  }
}

// Заголовок CSP страницы магазина (блок 13 «Секций и SDK», часть 13в): режим — переменная STOREFRONT_CSP образа,
// политика — поле csp служебной строки сборки. Не HTML, нет политики или режим не report/enforce — {}.
const cspFor = (r, meta, type) => route.cspHeaders(r.variables.sf_csp_mode, meta, type);

// 404 и 410 — страницей 404 темы, если она есть в сборке; иначе встроенным текстом.
async function sendPage(r, meta, kind) {
  const uri = route.notFoundUri(meta);
  if (uri === null) return sendText(r, kind);
  const reply = await r.subrequest(uri);
  if (reply.status !== 200) return sendText(r, kind);
  const headers = { 'Content-Type': PAGE_TYPE, 'Cache-Control': 'no-cache', ...cspFor(r, meta, PAGE_TYPE) };
  send(r, route.PAGE_STATUS[kind], headers, reply.responseText);
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
  await keepUnavailable(r, table);
  ROUTES.set(prefix + route.LOADED_KEY, String(Date.now()));
  return prefix;
}

// Заголовки файла ставит фильтр /_blob/ (fileHeaders ниже): njs передаёт их через переменные запроса. CSP HTML-файла
// (часть 13в) — и у 304, и у файла: JSON заголовков в sf_csp.
function sendFile(r, answer, meta) {
  const csp = cspFor(r, meta, answer.headers['Content-Type']);
  if (answer.kind === 'not-modified') return send(r, 304, { ...answer.headers, ...csp }, '');
  r.variables.sf_csp = JSON.stringify(csp);
  r.variables.sf_type = answer.headers['Content-Type'];
  r.variables.sf_cache = answer.headers['Cache-Control'];
  r.variables.sf_etag = answer.headers.ETag;
  r.variables.sf_modified = answer.headers['Last-Modified'] ?? '';
  r.internalRedirect(answer.uri);
}

const SENDERS = {
  file: (r, meta, answer) => sendFile(r, answer, meta),
  'not-modified': (r, meta, answer) => sendFile(r, answer, meta),
  redirect: (r, meta, answer) => r.return(301, answer.location),
  gone: (r, meta) => sendPage(r, meta, 'gone'),
  'not-found': (r, meta) => sendPage(r, meta, 'not-found'),
};

const sendAnswer = (r, meta, answer) => SENDERS[answer.kind](r, meta, answer);

// Рисовальщик (Св-1 В): одинаковые промахи склеивает кэш /_draw, перебор сверх лимита — 503 (storefront.conf.template).
async function draw(r, pointer, meta) {
  const reply = await r.subrequest('/_draw', { args: route.drawArgs(pointer, meta, r.uri) });
  const answer = route.drawAnswer(reply.status);
  if (answer === 'unavailable') return sendUnavailable(r);
  if (answer === 'not-found') return sendPage(r, meta, answer);
  const headers = route.drawnHeaders(reply.headersOut['X-Merfy-Hash']);
  send(r, 200, { ...headers, ...cspFor(r, meta, headers['Content-Type']) }, reply.responseText);
}

// Страница со списком с параметрами списка (блок 11 «Секций и SDK», часть 11а-2): только номер страницы и страница N есть
// в сборке — 301 туда; иначе рисовальщик рисует страницу с параметрами (в список дорисовок она не идёт). Рисовальщик
// занят, упал или не успел — файл сборки без параметров: покупатель видит список, модуль «Каталог» — что параметры не
// применились (у страницы нет meta merfy-list). Такой страницы нет (номер больше последнего) — 404 страницей магазина.
async function listed(r, served, list) {
  const { pointer, prefix, meta, row } = served;
  if (list.kind === 'page' && ROUTES.get(prefix + list.location) !== undefined) return r.return(301, list.location);
  const reply = await r.subrequest('/_draw', { args: route.drawArgs(pointer, meta, r.uri, list.list) });
  const answer = route.drawAnswer(reply.status);
  if (answer === 'not-found') return sendPage(r, meta, answer);
  if (answer === 'unavailable') return sendFile(r, route.fileAnswer(row, undefined), meta);
  const headers = route.drawnHeaders(reply.headersOut['X-Merfy-Hash']);
  send(r, 200, { ...headers, ...cspFor(r, meta, headers['Content-Type']) }, reply.responseText);
}

// Промах: адрес со «/» на конце есть — 301 туда; есть в списке дорисовок — файл; есть в списке адресов — рисуем.
async function miss(r, pointer, prefix, meta) {
  const slash = route.slashForm(r.uri);
  if (slash !== null && ROUTES.get(prefix + slash) !== undefined)
    return sendAnswer(r, meta, { kind: 'redirect', location: route.withArgs(slash, r.variables.args) });
  const drawn = route.drawnRow(await readJson(r, route.drawnKey(pointer)), r.uri);
  if (drawn !== null) return sendFile(r, route.fileAnswer(drawn, r.headersIn['If-None-Match']), meta);
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
  const row = JSON.parse(entry);
  // Страница со списком и параметры списка (блок 11, часть 11а-2) — страница N или рисовальщик.
  const list = route.listAnswer(row, r.variables.args, r.uri);
  if (list !== null) return listed(r, { pointer, prefix, meta, row }, list);
  const request = { ifNoneMatch: r.headersIn['If-None-Match'], args: r.variables.args, now: Date.now() };
  return sendAnswer(r, meta, route.entryAnswer(row, request));
}

async function serve(r) {
  try {
    await answer(r);
  } catch (error) {
    r.error(String(error));
    sendUnavailable(r);
  }
}

function fileHeaders(r) {
  r.headersOut['Content-Type'] = r.variables.sf_type;
  r.headersOut['Cache-Control'] = r.variables.sf_cache;
  r.headersOut.ETag = r.variables.sf_etag;
  r.headersOut['Last-Modified'] = r.variables.sf_modified || undefined;
  // CSP HTML-файла (часть 13в): JSON заголовков, который записал sendFile; у других файлов — {}.
  Object.entries(JSON.parse(r.variables.sf_csp || '{}')).forEach(([name, value]) => {
    r.headersOut[name] = value;
  });
}

// Сколько строк в общей памяти и сколько места осталось — для пробы и для дежурного.
function status(r) {
  const body = { keys: ROUTES.size(), freeBytes: ROUTES.freeSpace() };
  send(r, 200, { 'Content-Type': 'application/json' }, `${JSON.stringify(body)}\n`);
}

export default { serve, unavailable: sendUnavailable, fileHeaders, status };
