// Чистые правила раздачи витрин новых тем (design.md блока 5, В5-1 Б). Без nginx: их проверяют тесты в Node, а
// serve.js применяет. Объекты хранилища пишет @merfy/storefront-storage (site-gen), формат версии 1:
// - указатель storefront/pointers/<метка хоста>.json — { v, shop, build, … };
// - таблица раздачи сборки storefront/routes/<магазин>/<сборка>.json — { v, shop, build, files, moved, gone,
//   notFound, versions }; строка файла — { h: отпечаток hex, t: тип содержимого, c: immutable | revalidate,
//   m?: дата правки данных страницы, l?: true — страница со списком (блок 11 «Секций и SDK»): параметры списка
//   рисует рисовальщик };
// - список дорисовок storefront/drawn/<магазин>/<сборка>.json — { v, rows: путь → строка файла };
// - список адресов сущностей storefront/entities/<магазин>.json — { v, paths }.

const FORMAT_VERSION = 1;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Метка хоста — как у прокси нынешних магазинов: первая часть имени, без точек и слешей.
const LABEL = /^[a-z0-9-]+$/;
const CACHE_CONTROL = { immutable: 'public, max-age=31536000, immutable', revalidate: 'no-cache' };
// Ответ рисовальщика → что отвечает раздача. Остальные коды и тайм-аут — «временно недоступно».
const DRAW_ANSWERS = { 200: 'drawn', 404: 'not-found' };
const DRAWN_PAGE_TYPE = 'text/html; charset=utf-8';
// Коды страниц «нет такой» и «удалено» (design.md, раздел 4, «Удалённое, коды ответа и карта сайта»).
export const PAGE_STATUS = { 'not-found': 404, gone: 410 };

// Ключи общей памяти: «магазин|сборка|путь»; служебные строки сборки — с «#», путь запроса с него не начинается.
export const LOADED_KEY = '#loaded';
export const META_KEY = '#meta';
// Таблица разложена в память меньше 50 минут назад — свежая. Срок строк в зоне — час (storefront.conf.template).
export const RELOAD_AFTER_MS = 50 * 60 * 1000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isVersion1 = (value) => isRecord(value) && value.v === FORMAT_VERSION;

// Ошибку формата раздача не прячет: serve.js отвечает 503 и пишет её в журнал nginx.
function fail(what) {
  throw new Error(`storefront: ${what}`);
}

export function pointerKey(label) {
  if (!LABEL.test(label)) fail(`метка хоста «${label}» не подходит`);
  return `pointers/${label}.json`;
}

export function checkPointer(value) {
  const valid = isVersion1(value) && UUID.test(value.shop) && Number.isInteger(value.build);
  if (!valid) fail('указатель не формата v1');
  return { shop: value.shop, build: value.build };
}

export const tableKey = (pointer) => `routes/${pointer.shop}/${pointer.build}.json`;
export const drawnKey = (pointer) => `drawn/${pointer.shop}/${pointer.build}.json`;
export const entitiesKey = (pointer) => `entities/${pointer.shop}.json`;
export const tablePrefix = (pointer) => `${pointer.shop}|${pointer.build}|`;
export const isFresh = (loadedAt, now) => loadedAt !== undefined && now - Number(loadedAt) < RELOAD_AFTER_MS;

function checkFileRow(path, row) {
  // l (блок 11, часть 11а-2) — только true: иначе раздача не поймёт, страница ли это со списком.
  const listFlag = row?.l === undefined || row?.l === true;
  const valid = isRecord(row) && HEX.test(row.h) && typeof row.t === 'string' && row.c in CACHE_CONTROL && listFlag;
  if (!valid) fail(`строка файла ${path} не формата v1`);
  return row;
}

const recordOf = (value, what) => (isRecord(value) ? value : fail(`${what} не формата v1`));
const entry = (prefix, path, value) => [prefix + path, JSON.stringify(value)];

// CSP витрины (блок 13 «Секций и SDK», часть 13в): политику пишет сборка в поле csp таблицы раздачи, режим — переменная
// STOREFRONT_CSP образа: report — Content-Security-Policy-Report-Only, enforce — Content-Security-Policy, другое — без
// заголовка. Map, а не объект: режимы «__proto__» и «constructor» заголовка не дают.
const CSP_HEADERS = new Map([
  ['report', 'Content-Security-Policy-Report-Only'],
  ['enforce', 'Content-Security-Policy'],
]);
const CSP_TEXT = /^[\x20-\x7e]{1,12288}$/;

// Поле csp таблицы → служебная строка сборки. Нет поля — {}; не строка печатных ASCII до 12 288 знаков — ошибка формата
// (как у других полей: 503 и строка в журнале nginx).
function cspOf(table) {
  if (table.csp === undefined) return {};
  if (typeof table.csp !== 'string' || !CSP_TEXT.test(table.csp)) fail('csp таблицы раздачи не формата v1');
  return { csp: table.csp };
}

// Строки таблицы для общей памяти: ключ — префикс сборки и путь, значение — JSON строки с её видом: файл, переезд
// (301) или удалённое (410 до даты). Последняя — служебная строка сборки: страница 404 темы и версии.
export function tableEntries(table, prefix) {
  const valid = isVersion1(table) && isRecord(table.files) && isRecord(table.versions);
  if (!valid) fail('таблица раздачи не формата v1');
  const files = Object.entries(table.files).map(([path, row]) =>
    entry(prefix, path, { kind: 'file', ...checkFileRow(path, row) }),
  );
  const moved = Object.entries(recordOf(table.moved, 'moved')).map(([path, to]) =>
    entry(prefix, path, { kind: 'moved', to }),
  );
  const gone = Object.entries(recordOf(table.gone, 'gone')).map(([path, until]) =>
    entry(prefix, path, { kind: 'gone', until }),
  );
  const meta = entry(prefix, META_KEY, { notFound: table.notFound, versions: table.versions, ...cspOf(table) });
  return [...files, ...moved, ...gone, meta];
}

export const blobUri = (hash) => `/_blob/${hash.slice(0, 2)}/${hash}`;

// Файл сборки, тело которого читает сам njs: /_text/ берёт его из хранилища без сжатия.
export const textUri = (hash) => `/_text/${hash.slice(0, 2)}/${hash}`;

// If-None-Match может нести несколько отпечатков и слабую пометку W/.
function sameEtag(ifNoneMatch, etag) {
  const tags = String(ifNoneMatch ?? '').split(',');
  return tags.map((tag) => tag.trim().replace(/^W\//, '')).includes(etag);
}

export function fileHeaders(row) {
  const headers = { 'Content-Type': row.t, 'Cache-Control': CACHE_CONTROL[row.c], ETag: `"${row.h}"` };
  if (row.m !== undefined) headers['Last-Modified'] = new Date(row.m).toUTCString();
  return headers;
}

// Ответ строкой файла: у браузера тот же отпечаток — 304 без тела, иначе файл из хранилища.
export function fileAnswer(row, ifNoneMatch) {
  const headers = fileHeaders(row);
  if (sameEtag(ifNoneMatch, headers.ETag)) return { kind: 'not-modified', headers };
  return { kind: 'file', headers, uri: blobUri(row.h) };
}

export const withArgs = (location, args) => (args ? `${location}?${args}` : location);

// Строка таблицы → ответ. request — { ifNoneMatch, args, now }. Срок 410 вышел — обычная 404.
const ENTRY_ANSWERS = {
  file: (row, request) => fileAnswer(row, request.ifNoneMatch),
  moved: (row, request) => ({ kind: 'redirect', location: withArgs(row.to, request.args) }),
  gone: (row, request) => ({ kind: Date.parse(row.until) > request.now ? 'gone' : 'not-found' }),
};

export const entryAnswer = (row, request) => ENTRY_ANSWERS[row.kind](row, request);

// Адрес без «/» на конце и без расширения: если есть такой же со «/», отвечаем 301 туда (/products/scarf → …/scarf/).
export function slashForm(uri) {
  const last = uri.slice(uri.lastIndexOf('/') + 1);
  return last === '' || last.includes('.') ? null : `${uri}/`;
}

// Обратный случай (блок 11): адрес со «/» на конце, а в сборке такой же без «/» — 301 туда. Адреса страниц списков в
// плане блока 11 — со «/» (/catalog/page/2/), сборка делает их без «/»; «/» не отбрасывается у корня.
export function noSlashForm(uri) {
  return uri.length > 1 && uri.endsWith('/') ? uri.slice(0, -1) : null;
}

// Строка списка дорисовок для адреса или null. Списка нет — null.
export function drawnRow(list, uri) {
  if (list === null) return null;
  const rows = isVersion1(list) ? recordOf(list.rows, 'список дорисовок') : fail('список дорисовок не формата v1');
  return rows[uri] === undefined ? null : checkFileRow(uri, rows[uri]);
}

// Есть ли адрес в списке адресов сущностей (В5-7 Б). Списка нет — нет и адреса.
export function isListed(list, uri) {
  if (list === null) return false;
  if (!isVersion1(list) || !Array.isArray(list.paths)) fail('список адресов сущностей не формата v1');
  return list.paths.includes(uri);
}

// Параметры списка (блок 11 «Секций и SDK», часть 11а-2; design.md блока 11, 11.4): страница со списком (строка файла с
// l: true) с параметрами списка рисуется по запросу — их выбирает покупатель фильтрами каталога. Имена — те, что
// принимает шлюз (site-gen, packages/storefront-build/src/list-query.ts); filter.<ключ группы> — по началу имени. Чужие
// параметры (utm_source, yclid…) рисовальщика не зовут: обычный файл сборки.
const LIST_NAMES = ['availability', 'collection', 'max_price', 'min_price', 'page', 'q', 'sort'];
const LIST_FILTER_PREFIX = 'filter.';
// Длиннее — файл сборки без параметров: ключ кеша рисовальщика не растёт без предела.
export const LIST_MAX = 2048;
const ONLY_PAGE = /^page=([1-9][0-9]{0,5})$/;
const PAGE_SUFFIX = /\/page\/[1-9][0-9]{0,5}$/;

const isListName = (name) =>
  LIST_NAMES.includes(name) || (name.startsWith(LIST_FILTER_PREFIX) && name.length > LIST_FILTER_PREFIX.length);

// «+» в адресе — пробел, как у URLSearchParams сборщика. Битая кодировка — пары нет; другие ошибки не прячем.
function decodedPart(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function listPair(part) {
  const at = part.indexOf('=');
  const name = decodedPart(at === -1 ? part : part.slice(0, at));
  const value = decodedPart(at === -1 ? '' : part.slice(at + 1));
  if (name === null || value === null || value.trim() === '' || !isListName(name)) return null;
  return [name, value];
}

// По имени, внутри имени — по порядку адреса: номер пары в сравнении, порядок не зависит от сортировки движка.
function byName(left, right) {
  if (left.pair[0] !== right.pair[0]) return left.pair[0] < right.pair[0] ? -1 : 1;
  return left.index - right.index;
}

// Параметры списка в каноническом виде, как listQueryString сборки: имена по алфавиту, значения одного имени — по
// порядку адреса. Нет параметров списка — ''.
export function listArgs(args) {
  const parts = String(args ?? '')
    .split('&')
    .filter((part) => part !== '');
  const pairs = parts.map(listPair).filter((pair) => pair !== null);
  const ordered = pairs.map((pair, index) => ({ pair, index })).sort(byName);
  return ordered.map(({ pair }) => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`).join('&');
}

// Адрес страницы N списка — …/page/N без «/» на конце, как у сборки (site-gen, Р11а-4); первая — адрес списка.
export function pageLocation(uri, page) {
  const base = uri.replace(PAGE_SUFFIX, '') || '/';
  if (page === 1) return base;
  return `${base === '/' ? '' : base}/page/${page}`;
}

// Строка таблицы и параметры запроса → что делать со страницей списка. null — обычный ответ строкой; page — только
// номер страницы: 301 на страницу N, если она есть в таблице (это решает serve.js), иначе рисовальщик; draw —
// рисовальщик с параметрами.
export function listAnswer(row, args, uri) {
  if (row.kind !== 'file' || row.l !== true) return null;
  const list = listArgs(args);
  if (list === '' || list.length > LIST_MAX) return null;
  const only = ONLY_PAGE.exec(list);
  if (only === null) return { kind: 'draw', list };
  return { kind: 'page', location: pageLocation(uri, Number(only[1])), list };
}

// Запрос к рисовальщику (Св-1 В): магазин, сборка, путь и версии живой сборки — рисует только своей версией. list —
// параметры списка в каноническом виде (блок 11, часть 11а-2): страница рисуется с ними и в список дорисовок не идёт.
export function drawArgs(pointer, meta, path, list = '') {
  const query = [
    ['shop', pointer.shop],
    ['build', String(pointer.build)],
    ['path', path],
    ['render', meta.versions.render],
    ['theme', meta.versions.theme],
  ];
  const withList = list === '' ? query : [...query, ['list', list]];
  return withList.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
}

export const drawAnswer = (status) => DRAW_ANSWERS[status] ?? 'unavailable';

export function drawnHeaders(hash) {
  const row = { h: hash, t: DRAWN_PAGE_TYPE, c: 'revalidate' };
  return HEX.test(String(hash)) ? fileHeaders(row) : { 'Content-Type': DRAWN_PAGE_TYPE, 'Cache-Control': 'no-cache' };
}

// Заголовок CSP ответа (часть 13в): режим, служебная строка сборки и тип содержимого → { имя: политика } или {}.
export function cspHeaders(mode, meta, type) {
  const name = CSP_HEADERS.get(String(mode));
  const policy = meta === null || meta === undefined ? undefined : meta.csp;
  if (name === undefined || policy === undefined || !String(type).startsWith('text/html')) return {};
  return { [name]: policy };
}

// Страница 404 или 410: у темы есть страница 404 — её файл, иначе встроенный текст раздачи. Тело страницы отдаёт njs,
// поэтому файл берётся через /_text/, без сжатия.
export const notFoundUri = (meta) => (meta !== null && HEX.test(String(meta.notFound)) ? textUri(meta.notFound) : null);

// Копия страницы 502 магазина (блок 7 «Секций и SDK», часть 7а): 502.html текущей сборки, хеш — поле unavailable
// таблицы. В общей памяти sf_unavailable по метке хоста — «хеш, перевод строки, HTML». Копии нет — нейтральная страница.
export const NEUTRAL_UNAVAILABLE =
  '<!doctype html><html lang="ru"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">' +
  '<title>Сайт временно недоступен</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;' +
  'justify-content:center;background:#fff;color:#111;font-family:system-ui,sans-serif;text-align:center}' +
  'h1{margin:0 0 12px;font-size:28px;line-height:1.2}p{margin:0;color:#555}</style></head><body><main>' +
  '<h1>Сайт временно недоступен</h1><p>Попробуйте через минуту</p></main></body></html>';

export const unavailableHash = (table) =>
  isRecord(table) && HEX.test(String(table.unavailable)) ? table.unavailable : null;
export const keptValue = (hash, html) => `${hash}\n${html}`;
export const isKept = (value, hash) => typeof value === 'string' && value.startsWith(`${hash}\n`);

export function keptHtml(value) {
  const at = typeof value === 'string' ? value.indexOf('\n') : -1;
  return at > 0 ? value.slice(at + 1) : NEUTRAL_UNAVAILABLE;
}

export default {
  PAGE_STATUS,
  LOADED_KEY,
  META_KEY,
  RELOAD_AFTER_MS,
  pointerKey,
  checkPointer,
  tableKey,
  drawnKey,
  entitiesKey,
  tablePrefix,
  isFresh,
  tableEntries,
  blobUri,
  textUri,
  fileHeaders,
  fileAnswer,
  cspHeaders,
  withArgs,
  entryAnswer,
  slashForm,
  noSlashForm,
  drawnRow,
  isListed,
  drawArgs,
  drawAnswer,
  LIST_MAX,
  listArgs,
  listAnswer,
  pageLocation,
  drawnHeaders,
  notFoundUri,
  NEUTRAL_UNAVAILABLE,
  unavailableHash,
  keptValue,
  isKept,
  keptHtml,
};
