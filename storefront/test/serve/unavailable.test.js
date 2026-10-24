// Копия страницы 502 (блок 7 «Секций и SDK», часть 7а): раздача держит 502.html текущей сборки магазина в общей памяти
// и отдаёт её, когда хранилище или рендерер не ответили; копии нет — нейтральная страница. Стенд — `pnpm stack:up`.
import { beforeAll, describe, expect, it } from 'vitest';
import route from '../../njs/route.js';
import { META_CACHE_MS, breakPointer, ensureBucket, fileRow, get, seedShop, wait } from './stand.js';

const COPY = '<!doctype html><title>Сайт временно недоступен · Шарфы</title><h1>Сайт временно недоступен</h1>';
const MISSING = { h: 'f'.repeat(64), t: 'text/html; charset=utf-8', c: 'revalidate', m: '2026-10-06T09:00:00.000Z' };

let home;
let copy;

beforeAll(async () => {
  await ensureBucket();
  home = await fileRow('<!doctype html><title>Главная</title>');
  copy = await fileRow(COPY);
});

function expectUnavailable(reply, body) {
  expect(reply.status).toBe(503);
  expect(reply.headers['retry-after']).toBe('5');
  expect(reply.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(reply.body).toBe(body);
}

describe('копия страницы 502', () => {
  it('магазин открывали, потом указатель не читается — 503 и копия 502.html магазина', async () => {
    const shop = await seedShop({ files: { '/': home }, unavailable: copy.h });
    expect((await get(shop.label, '/')).status).toBe(200);
    await breakPointer(shop);
    await wait(META_CACHE_MS);
    expectUnavailable(await get(shop.label, '/'), COPY);
  });

  it('магазин не открывали — нейтральная страница', async () => {
    const shop = await seedShop({ files: { '/': home }, unavailable: copy.h });
    await breakPointer(shop);
    expectUnavailable(await get(shop.label, '/'), route.NEUTRAL_UNAVAILABLE);
  });

  it('в таблице копии нет (сборка до части 7а) — нейтральная страница', async () => {
    const shop = await seedShop({ files: { '/': home } });
    expect((await get(shop.label, '/')).status).toBe(200);
    await breakPointer(shop);
    await wait(META_CACHE_MS);
    expectUnavailable(await get(shop.label, '/'), route.NEUTRAL_UNAVAILABLE);
  });

  it('файла сборки нет в хранилище — 503 и копия магазина', async () => {
    const shop = await seedShop({ files: { '/': home, '/broken/': MISSING }, unavailable: copy.h });
    expectUnavailable(await get(shop.label, '/broken/'), COPY);
  });

  it('рендерер страниц не ответил — 503 и копия магазина', async () => {
    const shop = await seedShop({ files: { '/': home }, unavailable: copy.h, entities: ['/products/slow-copy/'] });
    expectUnavailable(await get(shop.label, '/products/slow-copy/'), COPY);
  });
});
