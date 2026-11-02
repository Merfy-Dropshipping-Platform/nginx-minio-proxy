// Переключение указателя (публикация магазина): чтения монотонны — покупатель, увидевший новую сборку, следующим
// запросом не получает старую. Гонку ставит задвижка стенда (test/storage-gate.mjs): ответ хранилища на указатель,
// прочитанный до переключения, приходит в раздачу после того, как другой запрос уже прочитал новый. Стенд —
// `pnpm stack:up`.
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

beforeAll(async () => {
  await ensureBucket();
  first = await fileRow(`<!doctype html><title>Главная сборки 1 ${RUN}</title>`);
  second = await fileRow(`<!doctype html><title>Главная сборки 2 ${RUN}</title>`);
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
});
