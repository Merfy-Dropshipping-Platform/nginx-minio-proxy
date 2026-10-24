// Стенд раздачи для проверок (compose.test.yml, `pnpm stack:up`): кладёт в хранилище сборку выдуманного магазина в
// формате @merfy/storefront-storage и спрашивает раздачу. У каждого магазина своя метка и свой id — проверки не мешают
// друг другу. Хранилище, раздача и подставной рисовальщик — на портах стенда.
import { createHash, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

// Версия рендера живой сборки — как RENDER_HASH подставного рисовальщика: иначе он отвечает 409.
export const RENDER = `sha256:${'1'.repeat(64)}`;
export const UPDATED_AT = '2026-10-06T09:00:00.000Z';
const BUCKET = 'merfy-sites';
const PROXY_PORT = 18081;
const RENDERER_URL = 'http://127.0.0.1:18082';
// Указатель, таблицы и списки раздача держит в кэше «1s»: nginx считает срок в целых секундах, и ответ живёт до двух
// секунд. После записи ждём дольше.
export const META_CACHE_MS = 2100;

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:19000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'storefront-test', secretAccessKey: 'storefront-test-only' },
});

const put = (key, body, type) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `storefront/${key}`, Body: body, ContentType: type }));
const putJson = (key, value) => put(key, JSON.stringify(value), 'application/json');
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function ensureBucket() {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (error) {
    if (error.name !== 'BucketAlreadyOwnedByYou') throw error;
  }
  const statement = {
    Effect: 'Allow',
    Principal: { AWS: ['*'] },
    Action: ['s3:GetObject'],
    Resource: [`arn:aws:s3:::${BUCKET}/storefront/*`],
  };
  const policy = JSON.stringify({ Version: '2012-10-17', Statement: [statement] });
  await s3.send(new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: policy }));
}

// Файл — в хранилище по отпечатку, с типом содержимого, как его кладёт пакет site-gen; строка файла для таблицы или
// списка дорисовок.
export async function fileRow(text, type = 'text/html; charset=utf-8', cache = 'revalidate') {
  const h = createHash('sha256').update(text).digest('hex');
  await put(`blobs/${h.slice(0, 2)}/${h}`, text, type);
  return cache === 'revalidate' ? { h, t: type, c: cache, m: UPDATED_AT } : { h, t: type, c: cache };
}

// Магазин со сборкой 1: files — «путь → строка файла», остальное — поля таблицы раздачи и списки.
export async function seedShop({ files, moved = {}, gone = {}, notFound = null, render = RENDER, entities = [] }) {
  const shop = { label: `t-${randomUUID().slice(0, 8)}`, id: randomUUID(), build: 1 };
  const versions = { render, theme: 'nova@0.0.1' };
  await putJson(`routes/${shop.id}/1.json`, { v: 1, shop: shop.id, build: 1, versions, notFound, files, moved, gone });
  await putJson(`entities/${shop.id}.json`, { v: 1, paths: entities });
  const pointer = { v: 1, shop: shop.id, build: 1, newest: 1, rev: 1, paused: false, pending: null, history: [] };
  await putJson(`pointers/${shop.label}.json`, pointer);
  return shop;
}

export const putDrawn = (shop, rows) => putJson(`drawn/${shop.id}/${shop.build}.json`, { v: 1, rows });

export function get(label, path, headers = {}) {
  const options = { host: '127.0.0.1', port: PROXY_PORT, path, headers: { Host: `${label}.dev.merfy.ru`, ...headers } };
  return new Promise((resolve, reject) => {
    const req = request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      // raw — байты как пришли: сжатый ответ сравнивают после распаковки.
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, body: raw.toString(), raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Сколько раз звали подставной рисовальщик с его старта.
export async function renderCalls() {
  const response = await fetch(`${RENDERER_URL}/calls`);
  return (await response.json()).count;
}

// Магазин со сборкой 1 и политикой CSP в таблице раздачи (блок 13 «Секций и SDK», часть 13в). Таблица переписывается
// до первого запроса к магазину — раздача читает её уже с csp.
export async function seedCspShop({ files, notFound = null, csp, entities = [] }) {
  const shop = await seedShop({ files, notFound, entities });
  const versions = { render: RENDER, theme: 'nova@0.0.1' };
  const table = { v: 1, shop: shop.id, build: 1, versions, notFound, files, moved: {}, gone: {}, csp };
  await putJson(`routes/${shop.id}/1.json`, table);
  return shop;
}
