// Переключение указателя (публикация магазина): чтения монотонны — покупатель, увидевший новую сборку, следующим
// запросом не получает старую. Гонку ставит задвижка стенда (test/storage-gate.mjs): ответ хранилища на указатель,
// прочитанный до переключения, приходит в раздачу после того, как другой запрос уже прочитал новый. Стенд —
// `pnpm stack:up`. Второй случай — копии указателя по заголовкам покупателя: хранилище отвечает с Vary, а главную
// браузер просит без Origin, модульный скрипт — с Origin.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  META_CACHE_MS,
  ensureBucket,
  fileRow,
  get,
  holdPointer,
  publish,
  releasePointer,
  seedShop,
  untilHeld,
  wait,
} from './stand.js';

const RUN = randomUUID();
let first;
let second;
let core;

beforeAll(async () => {
  await ensureBucket();
  first = await fileRow(`<!doctype html><title>Главная сборки 1 ${RUN}</title>`);
  second = await fileRow(`<!doctype html><title>Главная сборки 2 ${RUN}</title>`);
  core = await fileRow(`export const build = 2; // ${RUN}`, 'text/javascript; charset=utf-8', 'immutable');
});

async function untilBuild(shop, build) {
  for (let tries = 0; tries < 100; tries += 1) {
    if (buildOf(await get(shop.label, '/')) === build) return;
    await wait(50);
  }
  throw new Error(`главная не показала сборку ${build}`);
}

// Модульный скрипт браузер просит с Origin и сжатием — заголовки как у Chrome.
const scriptHeaders = (shop) => ({
  Origin: `https://${shop.label}.dev.merfy.ru`,
  'Accept-Encoding': 'gzip, deflate, br',
});

// Какую сборку увидел покупатель — по ETag главной.
const buildOf = (reply) => ({ [`"${first.h}"`]: 1, [`"${second.h}"`]: 2 })[reply.headers.etag];

describe('переключение указателя', () => {
  it('ответ хранилища, начатый до переключения, не возвращает старую сборку тем, кто пришёл позже', async () => {
    const shop = await seedShop({ files: { '/': first } });
    expect(buildOf(await get(shop.label, '/'))).toBe(1);
    await wait(META_CACHE_MS);

    await holdPointer(shop);
    const early = get(shop.label, '/');
    await untilHeld();
    await publish(shop, 2, { '/': second });
    const next = await get(shop.label, '/');
    await releasePointer();
    const held = await early;
    const after = await get(shop.label, '/');

    expect(buildOf(held)).toBe(1);
    // after начат, когда next и held уже ответили: сборка не старше той, что видели они.
    expect(buildOf(after)).toBeGreaterThanOrEqual(Math.max(buildOf(next), buildOf(held)));
    await wait(META_CACHE_MS);
    expect(buildOf(await get(shop.label, '/'))).toBe(2);
  });

  it('главная без Origin увидела новую сборку — её скрипт с Origin не ищется по старой', async () => {
    const shop = await seedShop({ files: { '/': first } });
    expect(buildOf(await get(shop.label, '/'))).toBe(1);
    await wait(META_CACHE_MS);
    // Скрипт с Origin читает указатель сборки 1, пока его запись свежая, — как вкладка, открытая до публикации.
    expect((await get(shop.label, '/', scriptHeaders(shop))).status).toBe(200);
    await publish(shop, 2, { '/': second, '/_merfy/b/core.js': core });

    // Главная без Origin — пока не увидит новую сборку; сразу следом браузер просит её скрипт.
    await untilBuild(shop, 2);
    const script = await get(shop.label, '/_merfy/b/core.js', scriptHeaders(shop));

    expect(script.status).toBe(200);
    expect(script.headers.etag).toBe(`"${core.h}"`);
  });
});
