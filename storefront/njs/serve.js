// Раздача витрин новых тем (design.md блока 5, В5-1 Б): метка хоста → указатель магазина → таблица раздачи его
// живой сборки → файл по отпечатку. Решения — в route.js, здесь только ввод-вывод nginx: подзапросы к кэшу
// хранилища (/_meta/), общая память (sf_routes) и ответ. Таблица сборки не меняется, поэтому её строки один раз
// раскладываются в общую память и дальше ищутся по одному ключу.
import route from 'route.js';

const ROUTES = ngx.shared.sf_routes;
const RETRY_AFTER_SECONDS = '5';
const PAGES = {
  'not-found': { status: 404, text: 'Страница не найдена' },
  unavailable: { status: 503, text: 'Магазин временно недоступен, попробуйте через минуту' },
};

function send(r, status, headers, body) {
  Object.entries(headers).forEach(([name, value]) => {
    r.headersOut[name] = value;
  });
  r.return(status, body);
}

function sendPage(r, kind) {
  const page = PAGES[kind];
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' };
  if (page.status === 503) headers['Retry-After'] = RETRY_AFTER_SECONDS;
  send(r, page.status, headers, `${page.text}\n`);
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

// Промах (Св-1 В): страницы нет в сборке — раздача зовёт рисовальщик.
async function draw(r, pointer, meta) {
  const reply = await r.subrequest('/_draw', { args: route.drawArgs(pointer, meta, r.uri) });
  const answer = route.drawAnswer(reply.status);
  if (answer !== 'drawn') return sendPage(r, answer);
  send(r, 200, route.drawnHeaders(reply.headersOut['X-Merfy-Hash']), reply.responseText);
}

async function answer(r) {
  const raw = await readJson(r, route.pointerKey(r.variables.merfy_label));
  if (raw === null) return sendPage(r, 'not-found');
  const pointer = route.checkPointer(raw);
  const prefix = await ensureTable(r, pointer);
  const entry = ROUTES.get(prefix + r.uri);
  if (entry !== undefined) return sendFile(r, route.fileAnswer(JSON.parse(entry), r.headersIn['If-None-Match']));
  return draw(r, pointer, JSON.parse(ROUTES.get(prefix + route.META_KEY)));
}

async function serve(r) {
  try {
    await answer(r);
  } catch (error) {
    r.error(String(error));
    sendPage(r, 'unavailable');
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
