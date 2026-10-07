// Чистые правила раздачи витрин новых тем (design.md блока 5, В5-1 Б). Без nginx: их проверяют тесты в Node, а
// serve.js применяет. Объекты хранилища пишет @merfy/storefront-storage (site-gen), формат версии 1:
// - указатель storefront/pointers/<метка хоста>.json — { v, shop, build, … };
// - таблица раздачи сборки storefront/routes/<магазин>/<сборка>.json — { v, shop, build, files, moved, gone,
//   notFound, versions }; строка файла — { h: отпечаток hex, t: тип содержимого, c: immutable | revalidate,
//   m?: дата правки данных страницы }.

const FORMAT_VERSION = 1;
const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Метка хоста — как у прокси нынешних магазинов: первая часть имени, без точек и слешей.
const LABEL = /^[a-z0-9-]+$/;
const CACHE_CONTROL = { immutable: 'public, max-age=31536000, immutable', revalidate: 'no-cache' };
// Ответ рисовальщика → что отвечает раздача. Остальные коды и тайм-аут — «временно недоступно».
const DRAW_ANSWERS = { 200: 'drawn', 404: 'not-found' };
const DRAWN_PAGE_TYPE = 'text/html; charset=utf-8';

// Ключи общей памяти: «магазин|сборка|путь»; служебные строки сборки — с «#», путь запроса с него не начинается.
export const LOADED_KEY = '#loaded';
export const META_KEY = '#meta';
// Таблица разложена в память меньше 50 минут назад — свежая. Срок строк в зоне — час (storefront.conf.template).
export const RELOAD_AFTER_MS = 50 * 60 * 1000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Ошибку формата раздача не прячет: serve.js отвечает 503 и пишет её в журнал nginx.
function fail(what) {
  throw new Error(`storefront: ${what}`);
}

export function pointerKey(label) {
  if (!LABEL.test(label)) fail(`метка хоста «${label}» не подходит`);
  return `pointers/${label}.json`;
}

export function checkPointer(value) {
  const valid = isRecord(value) && value.v === FORMAT_VERSION && UUID.test(value.shop) && Number.isInteger(value.build);
  if (!valid) fail('указатель не формата v1');
  return { shop: value.shop, build: value.build };
}

export const tableKey = (pointer) => `routes/${pointer.shop}/${pointer.build}.json`;
export const tablePrefix = (pointer) => `${pointer.shop}|${pointer.build}|`;
export const isFresh = (loadedAt, now) => loadedAt !== undefined && now - Number(loadedAt) < RELOAD_AFTER_MS;

function checkFileRow(path, row) {
  const valid = isRecord(row) && HEX.test(row.h) && typeof row.t === 'string' && row.c in CACHE_CONTROL;
  if (!valid) fail(`строка файла ${path} не формата v1`);
  return row;
}

// Строки таблицы для общей памяти: ключ — префикс сборки и путь, значение — JSON строки с её видом.
export function tableEntries(table, prefix) {
  const valid = isRecord(table) && table.v === FORMAT_VERSION && isRecord(table.files) && isRecord(table.versions);
  if (!valid) fail('таблица раздачи не формата v1');
  const files = Object.entries(table.files).map(([path, row]) => [
    prefix + path,
    JSON.stringify({ kind: 'file', ...checkFileRow(path, row) }),
  ]);
  const meta = [prefix + META_KEY, JSON.stringify({ notFound: table.notFound, versions: table.versions })];
  return [...files, meta];
}

export const blobUri = (hash) => `/_blob/${hash.slice(0, 2)}/${hash}`;

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

// Запрос к рисовальщику (Св-1 В): магазин, сборка, путь и версии живой сборки — рисует только своей версией.
export function drawArgs(pointer, meta, path) {
  const query = [
    ['shop', pointer.shop],
    ['build', String(pointer.build)],
    ['path', path],
    ['render', meta.versions.render],
    ['theme', meta.versions.theme],
  ];
  return query.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&');
}

export const drawAnswer = (status) => DRAW_ANSWERS[status] ?? 'unavailable';

export function drawnHeaders(hash) {
  const row = { h: hash, t: DRAWN_PAGE_TYPE, c: 'revalidate' };
  return HEX.test(String(hash)) ? fileHeaders(row) : { 'Content-Type': DRAWN_PAGE_TYPE, 'Cache-Control': 'no-cache' };
}

export default {
  LOADED_KEY,
  META_KEY,
  RELOAD_AFTER_MS,
  pointerKey,
  checkPointer,
  tableKey,
  tablePrefix,
  isFresh,
  tableEntries,
  blobUri,
  fileHeaders,
  fileAnswer,
  drawArgs,
  drawAnswer,
  drawnHeaders,
};
