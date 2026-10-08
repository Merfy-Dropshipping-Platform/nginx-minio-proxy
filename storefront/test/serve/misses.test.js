// Промахи (задача 11; design.md, раздел 5, пункт 8): адреса нет в таблице сборки. Есть в списке дорисовок — файл из
// списка; есть в списке адресов сущностей — рисовальщик; нет нигде — 404 без вызова рисовальщика. Одинаковые промахи
// склеиваются в один вызов, перебор адресов упирается в лимит. Стенд — `pnpm stack:up`.
import { beforeAll, describe, expect, it } from 'vitest';
import { META_CACHE_MS, ensureBucket, fileRow, get, putDrawn, renderCalls, seedShop, wait } from './stand.js';

const NOT_FOUND_PAGE = '<!doctype html><title>Такой страницы нет</title>';
const DRAWN_PAGE = '<!doctype html><title>Из списка дорисовок</title>';

let home;
let notFound;

beforeAll(async () => {
  await ensureBucket();
  home = await fileRow('<!doctype html><title>Главная</title>');
  notFound = await fileRow(NOT_FOUND_PAGE);
});

const shopWith = (entities, extra = {}) => seedShop({ files: { '/': home }, notFound: notFound.h, entities, ...extra });
const statuses = (replies) => replies.map((reply) => reply.status);

// Ответы и сколько раз за это время позвали рисовальщик.
async function withCalls(requests) {
  const before = await renderCalls();
  const replies = await requests();
  return { replies, calls: (await renderCalls()) - before };
}

async function inSequence(label, paths) {
  const replies = [];
  for (const path of paths) replies.push(await get(label, path));
  return replies;
}

describe('промах: адреса нет в сборке', () => {
  it('адрес сущности — 200 с первого запроса, второй — из списка дорисовок, рисовальщик вызван один раз', async () => {
    const shop = await shopWith(['/products/new-arrival/']);
    const first = await withCalls(() => inSequence(shop.label, ['/products/new-arrival/']));
    // Строку дорисовки пишет рисовальщик (блок 6, recordDrawnPage); здесь её пишет тест — со своим телом.
    const row = await fileRow(DRAWN_PAGE);
    await putDrawn(shop, { '/products/new-arrival/': row });
    await wait(META_CACHE_MS);
    const second = await withCalls(() => inSequence(shop.label, ['/products/new-arrival/']));
    expect(statuses(first.replies)).toEqual([200]);
    expect(first.replies[0].body).toContain('/products/new-arrival/');
    expect(first.replies[0].headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(first.calls).toBe(1);
    expect(second.replies[0].body).toBe(DRAWN_PAGE);
    expect(second.replies[0].headers.etag).toBe(`"${row.h}"`);
    expect(second.calls).toBe(0);
  });

  it('пять одновременных запросов одного адреса — один вызов рисовальщика', async () => {
    const shop = await shopWith(['/products/popular/']);
    const same = Array.from({ length: 5 }, () => get(shop.label, '/products/popular/'));
    const { replies, calls } = await withCalls(() => Promise.all(same));
    expect(statuses(replies)).toEqual([200, 200, 200, 200, 200]);
    expect(calls).toBe(1);
  });

  it('сто случайных адресов подряд — 404 страницей темы, рисовальщик не вызван ни разу', async () => {
    const shop = await shopWith(['/products/new-arrival/']);
    const paths = Array.from({ length: 100 }, (_, index) => `/products/random-${index}/`);
    const { replies, calls } = await withCalls(() => inSequence(shop.label, paths));
    expect(new Set(statuses(replies))).toEqual(new Set([404]));
    expect(replies[0].body).toBe(NOT_FOUND_PAGE);
    expect(calls).toBe(0);
  });

  it('у темы нет страницы 404 — встроенный текст', async () => {
    const shop = await seedShop({ files: { '/': home } });
    const reply = await get(shop.label, '/products/unknown/');
    expect(reply.status).toBe(404);
    expect(reply.body).toBe('Страница не найдена\n');
  });

  it('рисовальщик: «такой сущности нет» — 404 страницей темы, повтор берётся из кэша', async () => {
    const shop = await shopWith(['/products/missing-one/']);
    const paths = ['/products/missing-one/', '/products/missing-one/'];
    const { replies, calls } = await withCalls(() => inSequence(shop.label, paths));
    expect(statuses(replies)).toEqual([404, 404]);
    expect(replies[0].body).toBe(NOT_FOUND_PAGE);
    expect(calls).toBe(1);
  });

  it('рисовальщик молчит — 503 с Retry-After после тайм-аута', async () => {
    const shop = await shopWith(['/products/slow-one/']);
    const started = Date.now();
    const reply = await get(shop.label, '/products/slow-one/');
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('5');
    expect(Date.now() - started).toBeLessThan(3500);
  });

  it('живая сборка собрана другой версией рендера — 503', async () => {
    const shop = await shopWith(['/products/other-render/'], { render: `sha256:${'2'.repeat(64)}` });
    const reply = await get(shop.label, '/products/other-render/');
    expect(reply.status).toBe(503);
    expect(reply.headers['retry-after']).toBe('5');
  });

  it('перебор адресов сущностей — не больше лимита магазина, остальным 503', async () => {
    const paths = Array.from({ length: 10 }, (_, index) => `/products/listed-${index}/`);
    const shop = await shopWith(paths);
    const { replies, calls } = await withCalls(() => Promise.all(paths.map((path) => get(shop.label, path))));
    const drawn = statuses(replies).filter((status) => status === 200).length;
    expect(calls).toBe(drawn);
    expect(drawn).toBeLessThanOrEqual(3);
    expect(statuses(replies).filter((status) => status === 503)).toHaveLength(10 - drawn);
  });
});
