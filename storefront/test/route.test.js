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

  it('ключ таблицы и префикс строк — по магазину и сборке', () => {
    expect(route.tableKey({ shop: SHOP, build: 7 })).toBe(`routes/${SHOP}/7.json`);
    expect(route.tablePrefix({ shop: SHOP, build: 7 })).toBe(`${SHOP}|7|`);
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

  it.each([
    ['другая версия', { ...TABLE, v: 2 }],
    ['нет files', { ...TABLE, files: undefined }],
  ])('таблица: %s — ошибка формата', (name, table) => {
    expect(() => route.tableEntries(table, 'p|')).toThrow('таблица раздачи не формата v1');
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
