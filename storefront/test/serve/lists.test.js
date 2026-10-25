// Страница со списком и параметры списка (блок 11 «Секций и SDK», часть 11а-2): строка файла с l: true. Без параметров
// списка — файл сборки; только номер и страница N в сборке — 301; иначе — рисовальщик с параметрами в каноническом виде;
// рисовальщик не успел — файл сборки. Стенд — `pnpm stack:up`.
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBucket, fileRow, get, renderCalls, seedShop, wait } from './stand.js';

const CATALOG = '<!doctype html><title>Каталог</title>';
const ABOUT = '<!doctype html><title>О нас</title>';
const NOT_FOUND_PAGE = '<!doctype html><title>Такой страницы нет</title>';
const BLUE = '%D0%A1%D0%B8%D0%BD%D0%B8%D0%B9';
// Лимит рисовальщика стенда — 1 вызов в секунду на магазин, всплеск 2 (compose.test.yml): между вызовами — пауза.
const DRAW_GAP_MS = 1100;

let catalog;
let second;
let about;
let notFound;

beforeAll(async () => {
  await ensureBucket();
  catalog = { ...(await fileRow(CATALOG)), l: true };
  second = { ...(await fileRow('<!doctype html><title>Каталог — страница 2</title>')), l: true };
  about = await fileRow(ABOUT);
  notFound = await fileRow(NOT_FOUND_PAGE);
});

const shopOf = () =>
  seedShop({ files: { '/catalog': catalog, '/catalog/page/2': second, '/o-nas': about }, notFound: notFound.h });

async function withCalls(request) {
  const before = await renderCalls();
  const reply = await request();
  return { reply, calls: (await renderCalls()) - before };
}

describe('страница со списком', () => {
  it('без параметров и с чужими параметрами — файл сборки, рисовальщик не зовётся', async () => {
    const shop = await shopOf();
    for (const path of ['/catalog', '/catalog?utm_source=vk&yclid=1']) {
      const { reply, calls } = await withCalls(() => get(shop.label, path));
      expect([reply.status, reply.body, calls]).toEqual([200, CATALOG, 0]);
    }
  });

  it('только номер: страница N в сборке — 301 туда; первая — 301 на адрес списка', async () => {
    const shop = await shopOf();
    const two = await get(shop.label, '/catalog?page=2');
    expect([two.status, two.headers.location]).toEqual([301, '/catalog/page/2']);
    const one = await get(shop.label, '/catalog/page/2?page=1');
    expect([one.status, one.headers.location]).toEqual([301, '/catalog']);
  });

  it('фильтры — страница рисовальщика с параметрами в каноническом виде; тот же набор в другом порядке — из кеша', async () => {
    const shop = await shopOf();
    const first = await withCalls(() => get(shop.label, `/catalog?sort=price_asc&filter.cvet=${BLUE}`));
    expect([first.reply.status, first.calls]).toEqual([200, 1]);
    expect(first.reply.body).toContain(`<p data-list>filter.cvet=${BLUE}&sort=price_asc</p>`);
    const again = await withCalls(() => get(shop.label, `/catalog?filter.cvet=${BLUE}&sort=price_asc&utm_source=vk`));
    expect([again.reply.status, again.calls]).toEqual([200, 0]);
  });

  it('номер без страницы N в сборке — рисовальщик; такой страницы нет — 404 страницей магазина', async () => {
    const shop = await shopOf();
    const third = await withCalls(() => get(shop.label, '/catalog?page=3'));
    expect([third.reply.status, third.calls]).toEqual([200, 1]);
    expect(third.reply.body).toContain('<p data-list>page=3</p>');
    await wait(DRAW_GAP_MS);
    const missing = await get(shop.label, '/catalog?q=missing');
    expect([missing.status, missing.body]).toEqual([404, NOT_FOUND_PAGE]);
  });

  it('рисовальщик не успел — файл сборки без параметров, не 503', async () => {
    const shop = await shopOf();
    const slow = await get(shop.label, '/catalog?q=slow');
    expect([slow.status, slow.body]).toEqual([200, CATALOG]);
  });

  it('страница без списка — параметры не важны: файл сборки', async () => {
    const shop = await shopOf();
    const { reply, calls } = await withCalls(() => get(shop.label, '/o-nas?sort=price_asc'));
    expect([reply.status, reply.body, calls]).toEqual([200, ABOUT, 0]);
  });
});
