import { describe, expect, it } from 'vitest';
import route from '../njs/route.js';

const SHOP = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);
const ROW = { h: HASH, t: 'text/html; charset=utf-8', c: 'revalidate', m: '2026-10-06T09:00:00.000Z' };
const TABLE = {
  v: 1,
  shop: SHOP,
  build: 7,
  files: { '/': ROW, '/_astro/index.css': { h: 'b'.repeat(64), t: 'text/css; charset=utf-8', c: 'immutable' } },
  moved: {},
  gone: {},
  notFound: null,
  versions: { render: `sha256:${'1'.repeat(64)}`, theme: 'nova@0.0.1' },
};
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

describe('указатель', () => {
  it('ключ указателя — по метке хоста', () => {
    expect(route.pointerKey('scarf')).toBe('pointers/scarf.json');
  });

  it.each(['', 'a.b', '../x', 'Scarf'])('метка «%s» не проходит', (label) => {
    expect(() => route.pointerKey(label)).toThrow('метка хоста');
  });

  it('из указателя берёт магазин и сборку', () => {
    expect(route.checkPointer({ v: 1, shop: SHOP, build: 7, rev: 9, paused: false })).toEqual({ shop: SHOP, build: 7 });
  });

  it.each([
    ['другая версия', { v: 2, shop: SHOP, build: 7 }],
    ['магазин не uuid', { v: 1, shop: 'scarf', build: 7 }],
    ['сборка не число', { v: 1, shop: SHOP, build: '7' }],
    ['не объект', null],
  ])('%s — ошибка формата', (name, value) => {
    expect(() => route.checkPointer(value)).toThrow('указатель не формата v1');
  });

  it('ключи таблицы, списков и префикс строк — по магазину и сборке', () => {
    const pointer = { shop: SHOP, build: 7 };
    expect(route.tableKey(pointer)).toBe(`routes/${SHOP}/7.json`);
    expect(route.drawnKey(pointer)).toBe(`drawn/${SHOP}/7.json`);
    expect(route.entitiesKey(pointer)).toBe(`entities/${SHOP}.json`);
    expect(route.tablePrefix(pointer)).toBe(`${SHOP}|7|`);
  });
});

describe('таблица в общей памяти', () => {
  it('раскладка свежая меньше 50 минут', () => {
    const now = 10 * route.RELOAD_AFTER_MS;
    expect(route.isFresh(undefined, now)).toBe(false);
    expect(route.isFresh(String(now - 1000), now)).toBe(true);
    expect(route.isFresh(String(now - route.RELOAD_AFTER_MS), now)).toBe(false);
  });

  it('строки файлов и служебная строка сборки', () => {
    const entries = route.tableEntries(TABLE, 'p|');
    expect(entries.map(([key]) => key)).toEqual(['p|/', 'p|/_astro/index.css', `p|${route.META_KEY}`]);
    expect(JSON.parse(entries[0][1])).toEqual({ kind: 'file', ...ROW });
    expect(JSON.parse(entries[2][1])).toEqual({ notFound: null, versions: TABLE.versions });
  });

  it('переезды и удалённое — своими строками', () => {
    const table = { ...TABLE, moved: { '/old/': '/new/' }, gone: { '/gone/': '2027-04-08T12:00:00.000Z' } };
    const entries = Object.fromEntries(route.tableEntries(table, 'p|'));
    expect(JSON.parse(entries['p|/old/'])).toEqual({ kind: 'moved', to: '/new/' });
    expect(JSON.parse(entries['p|/gone/'])).toEqual({ kind: 'gone', until: '2027-04-08T12:00:00.000Z' });
  });

  it.each([
    ['другая версия', { ...TABLE, v: 2 }, 'таблица раздачи не формата v1'],
    ['нет files', { ...TABLE, files: undefined }, 'таблица раздачи не формата v1'],
    ['moved не объект', { ...TABLE, moved: [] }, 'moved не формата v1'],
  ])('таблица: %s — ошибка формата', (name, table, text) => {
    expect(() => route.tableEntries(table, 'p|')).toThrow(text);
  });

  it.each([
    ['короткий отпечаток', { ...ROW, h: 'abc' }],
    ['неизвестный кэш', { ...ROW, c: 'forever' }],
  ])('строка файла: %s — ошибка формата', (name, row) => {
    expect(() => route.tableEntries({ ...TABLE, files: { '/': row } }, 'p|')).toThrow('строка файла / не формата v1');
  });
});

describe('ответ строкой файла', () => {
  it('файл из хранилища: адрес по отпечатку и заголовки строки', () => {
    expect(route.fileAnswer(ROW, undefined)).toEqual({
      kind: 'file',
      uri: `/_blob/aa/${HASH}`,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        ETag: `"${HASH}"`,
        'Last-Modified': 'Tue, 06 Oct 2026 09:00:00 GMT',
      },
    });
  });

  it('файл с отпечатком в имени — кэш навсегда, без даты правки', () => {
    const answer = route.fileAnswer(TABLE.files['/_astro/index.css'], undefined);
    expect(answer.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(answer.headers).not.toHaveProperty('Last-Modified');
  });

  it.each([`"${HASH}"`, `W/"${HASH}"`, `"x", "${HASH}"`])('у браузера тот же отпечаток (%s) — 304', (header) => {
    expect(route.fileAnswer(ROW, header).kind).toBe('not-modified');
  });

  it('у браузера другой отпечаток — файл', () => {
    expect(route.fileAnswer(ROW, '"other"').kind).toBe('file');
  });
});

describe('строка таблицы → ответ', () => {
  const request = { ifNoneMatch: undefined, args: '', now: NOW };

  it('файл — как строка файла', () => {
    expect(route.entryAnswer({ kind: 'file', ...ROW }, request).kind).toBe('file');
  });

  it('переезд — 301 на новый адрес, параметры запроса сохраняются', () => {
    const moved = { kind: 'moved', to: '/products/scarf-winter/' };
    expect(route.entryAnswer(moved, request)).toEqual({ kind: 'redirect', location: '/products/scarf-winter/' });
    expect(route.entryAnswer(moved, { ...request, args: 'utm=1' }).location).toBe('/products/scarf-winter/?utm=1');
  });

  it('удалённое — 410 до даты, потом обычная 404', () => {
    expect(route.entryAnswer({ kind: 'gone', until: '2027-04-08T12:00:00.000Z' }, request)).toEqual({ kind: 'gone' });
    expect(route.entryAnswer({ kind: 'gone', until: '2026-10-01T00:00:00.000Z' }, request)).toEqual({
      kind: 'not-found',
    });
    expect(route.PAGE_STATUS).toEqual({ 'not-found': 404, gone: 410 });
  });
});

describe('промах', () => {
  it.each([
    ['/products/scarf', '/products/scarf/'],
    ['/products/scarf/', null],
    ['/robots.txt', null],
    ['/', null],
  ])('адрес %s — со слешем: %s', (uri, form) => {
    expect(route.slashForm(uri)).toBe(form);
  });

  it('список дорисовок: строка адреса или null', () => {
    const list = { v: 1, rows: { '/products/osen/': ROW } };
    expect(route.drawnRow(list, '/products/osen/')).toEqual(ROW);
    expect(route.drawnRow(list, '/products/none/')).toBeNull();
    expect(route.drawnRow(null, '/products/osen/')).toBeNull();
  });

  it.each([
    ['не v1', { v: 2, rows: {} }, 'список дорисовок не формата v1'],
    ['строка не по формату', { v: 1, rows: { '/x/': { h: 'abc' } } }, 'строка файла /x/ не формата v1'],
  ])('список дорисовок %s — ошибка формата', (name, list, text) => {
    expect(() => route.drawnRow(list, '/x/')).toThrow(text);
  });

  it('список адресов сущностей: есть адрес или нет; списка нет — нет', () => {
    const list = { v: 1, paths: ['/products/osen/'] };
    expect(route.isListed(list, '/products/osen/')).toBe(true);
    expect(route.isListed(list, '/products/random/')).toBe(false);
    expect(route.isListed(null, '/products/osen/')).toBe(false);
    expect(() => route.isListed({ v: 1, paths: 'x' }, '/x/')).toThrow('список адресов сущностей не формата v1');
  });

  it('страница 404 темы — файл по отпечатку через /_text/ (njs читает тело, сжатие не нужно); нет её — встроенная', () => {
    expect(route.notFoundUri({ notFound: HASH })).toBe(`/_text/aa/${HASH}`);
    expect(route.notFoundUri({ notFound: null })).toBeNull();
    expect(route.notFoundUri(null)).toBeNull();
  });
});

describe('промах и рисовальщик', () => {
  it('запрос к рисовальщику несёт магазин, сборку, путь и версии', () => {
    const meta = { versions: TABLE.versions };
    expect(route.drawArgs({ shop: SHOP, build: 7 }, meta, '/products/осень/')).toBe(
      `shop=${SHOP}&build=7&path=%2Fproducts%2F%D0%BE%D1%81%D0%B5%D0%BD%D1%8C%2F` +
        `&render=sha256%3A${'1'.repeat(64)}&theme=nova%400.0.1`,
    );
  });

  it.each([
    [200, 'drawn'],
    [404, 'not-found'],
    [409, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
  ])('рисовальщик ответил %i — %s', (status, answer) => {
    expect(route.drawAnswer(status)).toBe(answer);
  });

  it('дорисованная страница — с отпечатком рисовальщика', () => {
    expect(route.drawnHeaders(HASH)).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      ETag: `"${HASH}"`,
    });
  });

  it('отпечатка нет — страница без ETag', () => {
    expect(route.drawnHeaders(undefined)).toEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
  });
});

describe('CSP витрины (блок 13 «Секций и SDK», часть 13в)', () => {
  const POLICY = "default-src 'self'; object-src 'none'; base-uri 'none'";
  const META = { notFound: null, versions: TABLE.versions, csp: POLICY };
  const HTML = 'text/html; charset=utf-8';

  it('режим report — Report-Only, enforce — обязательный заголовок; только у HTML', () => {
    expect(route.cspHeaders('report', META, HTML)).toEqual({ 'Content-Security-Policy-Report-Only': POLICY });
    expect(route.cspHeaders('enforce', META, HTML)).toEqual({ 'Content-Security-Policy': POLICY });
    expect(route.cspHeaders('report', META, 'text/css; charset=utf-8')).toEqual({});
  });

  it.each(['off', '', 'Report', 'constructor', '__proto__', undefined])('режим «%s» — без заголовка', (mode) => {
    expect(route.cspHeaders(mode, META, HTML)).toEqual({});
  });

  it('у сборки нет политики или нет служебной строки — без заголовка', () => {
    expect(route.cspHeaders('report', { notFound: null, versions: TABLE.versions }, HTML)).toEqual({});
    expect(route.cspHeaders('report', null, HTML)).toEqual({});
  });

  it('политика таблицы — в служебной строке сборки; нет поля — строка прежняя', () => {
    expect(JSON.parse(route.tableEntries({ ...TABLE, csp: POLICY }, 'p|').at(-1)[1])).toEqual(META);
    expect(JSON.parse(route.tableEntries(TABLE, 'p|').at(-1)[1])).toEqual({ notFound: null, versions: TABLE.versions });
  });

  it.each([
    ['перевод строки', `${POLICY}\r\nX-Evil: 1`],
    ['не строка', 42],
    ['пусто', ''],
    ['длиннее 12 288', 'a'.repeat(12_289)],
  ])('csp таблицы: %s — ошибка формата', (_name, csp) => {
    expect(() => route.tableEntries({ ...TABLE, csp }, 'p|')).toThrow('csp таблицы раздачи не формата v1');
  });
});

describe('копия страницы 502 (блок 7 «Секций и SDK», часть 7а)', () => {
  const COPY = '<!doctype html><title>Сайт временно недоступен · Шарфы</title>';

  it('хеш копии — из таблицы; нет ключа или не hex — копии нет', () => {
    expect(route.unavailableHash({ ...TABLE, unavailable: HASH })).toBe(HASH);
    expect(route.unavailableHash(TABLE)).toBeNull();
    expect(route.unavailableHash({ ...TABLE, unavailable: 'abc' })).toBeNull();
    expect(route.unavailableHash(null)).toBeNull();
  });

  it('значение в памяти — хеш и HTML; тот же хеш — копия уже есть', () => {
    const value = route.keptValue(HASH, COPY);
    expect(route.isKept(value, HASH)).toBe(true);
    expect(route.isKept(value, 'b'.repeat(64))).toBe(false);
    expect(route.isKept(undefined, HASH)).toBe(false);
    expect(route.keptHtml(value)).toBe(COPY);
  });

  it('копии нет — нейтральная страница платформы: без цветов магазина', () => {
    expect(route.keptHtml(undefined)).toBe(route.NEUTRAL_UNAVAILABLE);
    expect(route.keptHtml('без перевода строки')).toBe(route.NEUTRAL_UNAVAILABLE);
    expect(route.NEUTRAL_UNAVAILABLE).toContain('<h1>Сайт временно недоступен</h1>');
    expect(route.NEUTRAL_UNAVAILABLE).not.toContain('var(--');
  });

  it('служебная строка сборки не меняется: копия хранится отдельно от таблицы', () => {
    const entries = route.tableEntries({ ...TABLE, unavailable: HASH }, 'p|');
    expect(JSON.parse(entries.at(-1)[1])).toEqual({ notFound: null, versions: TABLE.versions });
  });
});

describe('параметры списка (блок 11 «Секций и SDK», часть 11а-2)', () => {
  const LIST_ROW = { kind: 'file', ...ROW, l: true };
  const FILE_ROW = { kind: 'file', ...ROW };
  const BLUE = '%D0%A1%D0%B8%D0%BD%D0%B8%D0%B9';

  it('канонический вид: только параметры списка, имена по алфавиту, значения одного имени — по порядку адреса', () => {
    expect(
      route.listArgs(`utm_source=vk&sort=price_asc&filter.cvet=${BLUE}&filter.cvet=b&collection=len&yclid=1`),
    ).toBe(`collection=len&filter.cvet=${BLUE}&filter.cvet=b&sort=price_asc`);
    expect(route.listArgs('q=%D1%88%D0%B0%D1%80%D1%84+%D0%BB%D1%91%D0%BD')).toBe(
      'q=%D1%88%D0%B0%D1%80%D1%84%20%D0%BB%D1%91%D0%BD',
    );
    expect(route.listArgs('')).toBe('');
    expect(route.listArgs(undefined)).toBe('');
    expect(route.listArgs('q=&filter.=x&sort=%E0%A4%A&page')).toBe('');
  });

  it('страница со списком: без параметров списка — обычный файл; с ними — рисовальщик', () => {
    expect(route.listAnswer(LIST_ROW, '', '/catalog')).toBeNull();
    expect(route.listAnswer(LIST_ROW, 'utm_source=vk&yclid=1', '/catalog')).toBeNull();
    expect(route.listAnswer(LIST_ROW, 'sort=price_asc&q=x', '/catalog')).toEqual({
      kind: 'draw',
      list: 'q=x&sort=price_asc',
    });
    expect(route.listAnswer(LIST_ROW, `q=${'a'.repeat(route.LIST_MAX)}`, '/catalog')).toBeNull();
  });

  it('не страница со списком — параметры не важны', () => {
    expect(route.listAnswer(FILE_ROW, 'sort=price_asc', '/o-nas')).toBeNull();
    expect(route.listAnswer({ kind: 'moved', to: '/catalog' }, 'sort=price_asc', '/katalog')).toBeNull();
    expect(
      route.listAnswer({ kind: 'gone', until: '2027-01-01T00:00:00.000Z' }, 'page=2', '/collections/old'),
    ).toBeNull();
  });

  it('только номер — адрес страницы N без «/» на конце; первая — адрес списка; у главной — /page/N', () => {
    expect(route.listAnswer(LIST_ROW, 'page=2', '/catalog')).toEqual({
      kind: 'page',
      location: '/catalog/page/2',
      list: 'page=2',
    });
    expect(route.listAnswer(LIST_ROW, 'page=1', '/catalog/page/3')).toMatchObject({ location: '/catalog' });
    expect(route.listAnswer(LIST_ROW, 'page=4', '/collections/kashemir/page/2')).toMatchObject({
      location: '/collections/kashemir/page/4',
    });
    expect(route.listAnswer(LIST_ROW, 'page=2', '/')).toMatchObject({ location: '/page/2' });
    expect(route.listAnswer(LIST_ROW, 'page=1', '/page/2')).toMatchObject({ location: '/' });
    expect(route.listAnswer(LIST_ROW, 'page=0', '/catalog')).toEqual({ kind: 'draw', list: 'page=0' });
    expect(route.listAnswer(LIST_ROW, 'page=2&page=3', '/catalog')).toEqual({ kind: 'draw', list: 'page=2&page=3' });
  });

  it('рисовальщику — параметры списка аргументом list; без них — аргументы прежние', () => {
    const meta = { notFound: null, versions: TABLE.versions };
    const pointer = { shop: SHOP, build: 7 };
    expect(route.drawArgs(pointer, meta, '/catalog', 'q=x&sort=price_asc')).toBe(
      `${route.drawArgs(pointer, meta, '/catalog')}&list=q%3Dx%26sort%3Dprice_asc`,
    );
    expect(route.drawArgs(pointer, meta, '/catalog', '')).toBe(route.drawArgs(pointer, meta, '/catalog'));
  });

  it('строка файла: l — только true', () => {
    const table = (l) => ({ ...TABLE, files: { '/catalog': { ...ROW, l } } });
    expect(JSON.parse(route.tableEntries(table(true), 'p|')[0][1])).toEqual({ kind: 'file', ...ROW, l: true });
    expect(() => route.tableEntries(table(false), 'p|')).toThrow('строка файла /catalog не формата v1');
    expect(() => route.tableEntries(table(1), 'p|')).toThrow('строка файла /catalog не формата v1');
  });
});
