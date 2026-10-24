// CSP витрины (блок 13 «Секций и SDK», часть 13в): политика — поле csp таблицы раздачи, заголовок — у HTML-ответов
// магазина: файл, 304, страница 404 темы, дорисованная страница. У CSS и у магазина без политики заголовка нет. Режим
// стенда — report (умолчание Dockerfile): Content-Security-Policy-Report-Only. Стенд — `pnpm stack:up`.
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureBucket, fileRow, get, seedCspShop, seedShop } from './stand.js';

const POLICY = "default-src 'self'; object-src 'none'; base-uri 'none'; report-uri https://analytics.dev.merfy.ru/csp";
const REPORT = 'content-security-policy-report-only';
const ENFORCE = 'content-security-policy';

let shop;
let plain;
let home;

beforeAll(async () => {
  await ensureBucket();
  home = await fileRow('<!doctype html><title>Главная с CSP</title>');
  const styles = await fileRow('body{margin:0}', 'text/css; charset=utf-8', 'immutable');
  const notFound = await fileRow('<!doctype html><title>Нет такой страницы, CSP</title>');
  const files = { '/': home, '/styles.css': styles };
  shop = await seedCspShop({ files, notFound: notFound.h, csp: POLICY, entities: ['/products/csp-new/'] });
  plain = await seedShop({ files: { '/': home } });
});

const headersOf = (reply) => [reply.status, reply.headers[REPORT], reply.headers[ENFORCE]];

describe('заголовок CSP раздачи (часть 13в)', () => {
  it('главная, её 304, страница 404 темы и дорисованная страница — Report-Only с политикой таблицы', async () => {
    const replies = [
      await get(shop.label, '/'),
      await get(shop.label, '/', { 'If-None-Match': `"${home.h}"` }),
      await get(shop.label, '/nope/'),
      await get(shop.label, '/products/csp-new/'),
    ];
    expect(replies.map(headersOf)).toEqual([
      [200, POLICY, undefined],
      [304, POLICY, undefined],
      [404, POLICY, undefined],
      [200, POLICY, undefined],
    ]);
  });

  it('CSS магазина с политикой и HTML магазина без политики — без заголовка', async () => {
    const replies = [await get(shop.label, '/styles.css'), await get(plain.label, '/')];
    expect(replies.map(headersOf)).toEqual([
      [200, undefined, undefined],
      [200, undefined, undefined],
    ]);
  });
});
