// Раздача по таблице сборки (задача 11): файл и 304, переезд (301) с параметрами запроса, удалённое (410) страницей
// 404 темы и вышедший срок 410, адрес без «/» на конце, robots.txt из таблицы, файл ключа IndexNow. Стенд —
// `pnpm stack:up`.
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBucket, fileRow, get, seedShop } from './stand.js';

// Тела файлов — свои у каждого прогона: файла ещё нет в кэше раздачи, и заголовки хранилища каждый раз настоящие.
const RUN = randomUUID();
const HOME = `<!doctype html><title>Главная ${RUN}</title>`;
const NOT_FOUND_PAGE = '<!doctype html><title>Такой страницы нет</title>';
const ROBOTS = `User-agent: *\nDisallow: /\n# ${RUN}\n`;
const INDEXNOW_KEY = '5f0c8a2d9e4b4c7a8d1e6f3b2a9c0d47';

let shop;
let home;

beforeAll(async () => {
  await ensureBucket();
  home = await fileRow(HOME);
  const notFound = await fileRow(NOT_FOUND_PAGE);
  const robots = await fileRow(ROBOTS, 'text/plain; charset=utf-8');
  shop = await seedShop({
    files: { '/': home, '/products/scarf/': home, '/robots.txt': robots },
    moved: { '/products/old-scarf/': '/products/scarf/' },
    gone: { '/products/sold/': '2099-01-01T00:00:00.000Z', '/products/long-ago/': '2020-01-01T00:00:00.000Z' },
    notFound: notFound.h,
  });
});

describe('раздача по таблице сборки', () => {
  it('файл: тело, тип, кэш, отпечаток и дата правки — из таблицы', async () => {
    const reply = await get(shop.label, '/');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(HOME);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(reply.headers['cache-control']).toBe('no-cache');
    expect(reply.headers.etag).toBe(`"${home.h}"`);
    expect(reply.headers['last-modified']).toBe('Tue, 06 Oct 2026 09:00:00 GMT');
  });

  it('браузер принимает gzip: таблица новой сборки читается, файл приходит сжатым, тело то же', async () => {
    const fresh = await seedShop({ files: { '/': home } });
    const reply = await get(fresh.label, '/', { 'Accept-Encoding': 'gzip' });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(reply.raw).toString()).toBe(HOME);
  });

  it('у браузера тот же отпечаток — 304 без тела', async () => {
    const reply = await get(shop.label, '/', { 'If-None-Match': `"${home.h}"` });
    expect(reply.status).toBe(304);
    expect(reply.body).toBe('');
  });

  it('переезд — 301 на новый адрес, параметры запроса остаются', async () => {
    const reply = await get(shop.label, '/products/old-scarf/?utm_source=mail');
    expect(reply.status).toBe(301);
    expect(reply.headers.location).toBe('/products/scarf/?utm_source=mail');
  });

  it('удалённое — 410 страницей 404 темы', async () => {
    const reply = await get(shop.label, '/products/sold/');
    expect(reply.status).toBe(410);
    expect(reply.body).toBe(NOT_FOUND_PAGE);
    expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('срок 410 вышел — 404 страницей темы', async () => {
    const reply = await get(shop.label, '/products/long-ago/');
    expect(reply.status).toBe(404);
    expect(reply.body).toBe(NOT_FOUND_PAGE);
  });

  it('адрес без «/» на конце, а со «/» он есть — 301 туда', async () => {
    const reply = await get(shop.label, '/products/scarf?color=red');
    expect(reply.status).toBe(301);
    expect(reply.headers.location).toBe('/products/scarf/?color=red');
  });

  it('адрес со «/» на конце, а без «/» он есть — 301 туда (страница N из плана блока 11)', async () => {
    const pages = await seedShop({ files: { '/': home, '/catalog/page/2': home } });
    const reply = await get(pages.label, '/catalog/page/2/?q=%D0%BD%D0%BE%D0%B2%D0%B0');
    expect(reply.status).toBe(301);
    expect(reply.headers.location).toBe('/catalog/page/2?q=%D0%BD%D0%BE%D0%B2%D0%B0');
  });

  it('robots.txt — файл из таблицы сборки', async () => {
    const reply = await get(shop.label, '/robots.txt');
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(ROBOTS);
    expect(reply.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('файл ключа IndexNow — на любом хосте, даже без магазина', async () => {
    const reply = await get('nobody', `/${INDEXNOW_KEY}.txt`);
    expect(reply.status).toBe(200);
    expect(reply.body).toBe(INDEXNOW_KEY);
  });

  it('магазина с такой меткой нет — 404', async () => {
    const reply = await get('nobody', '/');
    expect(reply.status).toBe(404);
  });
});
