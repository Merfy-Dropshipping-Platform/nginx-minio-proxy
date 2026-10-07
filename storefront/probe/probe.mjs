// Проба раздачи (design.md блока 5, В5-1 Б). Стенд — compose.test.yml (`pnpm stack:up`), в хранилище — сборки двух
// выдуманных магазинов на 2000 и 20 000 страниц. Меряет время ответа, раскладку таблицы в память и память на строку,
// промах с вызовом рисовальщика и тайм-аутом, ответ при замёрзшем хранилище. Пороги — THRESHOLDS; не прошла — код 1.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Agent, request } from 'node:http';
import { CreateBucketCommand, PutBucketPolicyCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const BUCKET = 'merfy-sites';
const PROXY_PORT = 18081;
const AGENT = new Agent({ keepAlive: true, maxSockets: 8 });
const THRESHOLDS = { medianMs: 15, p95Ms: 40, loadMs: 1000, bytesPerRow: 1024, frozenColdMs: 3000, slowDrawMs: 3500 };
const RENDER = `sha256:${'1'.repeat(64)}`;
const BLOB_COUNT = 64;
const REQUESTS = 400;
const CONCURRENCY = 8;
const SHOPS = [
  { label: 'probe-2k', shop: '00000000-0000-4000-8000-000000002000', rows: 2000 },
  { label: 'probe-20k', shop: '00000000-0000-4000-8000-000000020000', rows: 20000 },
];

const s3 = new S3Client({
  endpoint: 'http://127.0.0.1:19000',
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: { accessKeyId: 'storefront-test', secretAccessKey: 'storefront-test-only' },
});

const hex = (body) => createHash('sha256').update(body).digest('hex');
const put = (key, body, type) =>
  s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `storefront/${key}`, Body: body, ContentType: type }));
const compose = (...args) =>
  execFileSync('docker', ['compose', '-f', 'compose.test.yml', ...args], { encoding: 'utf8' });
const line = (text) => process.stdout.write(`${text}\n`);

async function ensureBucket() {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (error) {
    if (error.name !== 'BucketAlreadyOwnedByYou') throw error;
  }
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${BUCKET}/storefront/*`],
      },
    ],
  };
  await s3.send(new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: JSON.stringify(policy) }));
}

async function seedBlobs() {
  const bodies = Array.from({ length: BLOB_COUNT }, (_, index) => `<!doctype html><title>Товар ${index}</title>`);
  const hashes = bodies.map(hex);
  await Promise.all(
    bodies.map((body, index) => put(`blobs/${hashes[index].slice(0, 2)}/${hashes[index]}`, body, 'text/plain')),
  );
  return hashes;
}

function tableOf(shop, hashes) {
  const row = (index) => ({
    h: hashes[index % hashes.length],
    t: 'text/html; charset=utf-8',
    c: 'revalidate',
    m: '2026-10-06T09:00:00.000Z',
  });
  const files = Object.fromEntries(
    Array.from({ length: shop.rows }, (_, index) => [`/products/p-${index}/`, row(index)]),
  );
  return {
    v: 1,
    shop: shop.shop,
    build: 1,
    files,
    moved: {},
    gone: {},
    notFound: null,
    versions: { render: RENDER, theme: 'nova@0.0.1' },
  };
}

async function seedShop(shop, hashes) {
  await put(`routes/${shop.shop}/1.json`, JSON.stringify(tableOf(shop, hashes)), 'application/json');
  await put(
    `pointers/${shop.label}.json`,
    JSON.stringify({ v: 1, shop: shop.shop, build: 1, newest: 1, rev: 1, paused: false, pending: null, history: [] }),
    'application/json',
  );
}

function get(label, path) {
  const started = performance.now();
  const options = {
    host: '127.0.0.1',
    port: PROXY_PORT,
    path,
    agent: AGENT,
    headers: { Host: `${label}.dev.merfy.ru` },
  };
  return new Promise((resolve, reject) => {
    const req = request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
          ms: performance.now() - started,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

const percentile = (sorted, share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];

async function steadyLatency(shop) {
  const times = [];
  let next = 0;
  const worker = async () => {
    for (; next < REQUESTS; next += 1)
      times.push((await get(shop.label, `/products/p-${(next * 7919) % shop.rows}/`)).ms);
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  times.sort((left, right) => left - right);
  return { median: percentile(times, 0.5), p95: percentile(times, 0.95) };
}

const freeBytes = () =>
  JSON.parse(compose('exec', '-T', 'proxy', 'wget', '-qO-', 'http://127.0.0.1/_storefront/status')).freeBytes;
const round = (value) => Math.round(value * 10) / 10;

async function measureLoad(results) {
  for (const shop of SHOPS) {
    const before = freeBytes();
    const first = await get(shop.label, '/products/p-1/');
    results.load[shop.rows] = {
      status: first.status,
      ms: round(first.ms),
      bytesPerRow: Math.round((before - freeBytes()) / (shop.rows + 1)),
    };
    line(
      `таблица на ${shop.rows} строк: первый запрос ${first.status} за ${round(first.ms)} мс, ${results.load[shop.rows].bytesPerRow} байт на строку`,
    );
  }
}

async function measureDraw(results) {
  const drawn = await get(SHOPS[0].label, '/products/new-arrival/');
  const slow = await get(SHOPS[0].label, '/products/slow/');
  results.draw = {
    drawn: drawn.status,
    slow: slow.status,
    slowMs: round(slow.ms),
    retryAfter: slow.headers['retry-after'],
  };
  line(`промах, рисовальщик нарисовал: ${drawn.status} за ${round(drawn.ms)} мс`);
  line(
    `промах, рисовальщик молчит: ${slow.status} за ${round(slow.ms)} мс, Retry-After ${slow.headers['retry-after']}`,
  );
}

async function measureFrozenStorage(results) {
  compose('pause', 'minio');
  try {
    const cached = await get(SHOPS[0].label, '/products/p-1/');
    const cold = await get('probe-cold', '/');
    results.frozen = { cached: cached.status, cold: cold.status, coldMs: round(cold.ms) };
    line(
      `хранилище замёрзло: страница из кэша — ${cached.status}; магазин без кэша — ${cold.status} за ${round(cold.ms)} мс`,
    );
  } finally {
    compose('unpause', 'minio');
  }
}

function failures(results) {
  const checks = [
    [results.steady.median <= THRESHOLDS.medianMs, `медиана ${results.steady.median} мс > ${THRESHOLDS.medianMs}`],
    [results.steady.p95 <= THRESHOLDS.p95Ms, `p95 ${results.steady.p95} мс > ${THRESHOLDS.p95Ms}`],
    ...Object.entries(results.load).flatMap(([rows, load]) => [
      [load.status === 200, `таблица ${rows}: ответ ${load.status}`],
      [load.ms <= THRESHOLDS.loadMs, `таблица ${rows}: раскладка ${load.ms} мс > ${THRESHOLDS.loadMs}`],
      [load.bytesPerRow <= THRESHOLDS.bytesPerRow, `таблица ${rows}: ${load.bytesPerRow} байт на строку`],
    ]),
    [results.draw.drawn === 200, `дорисовка: ${results.draw.drawn}`],
    [results.draw.slow === 503 && results.draw.retryAfter === '5', `рисовальщик молчит: ${results.draw.slow}`],
    [results.draw.slowMs <= THRESHOLDS.slowDrawMs, `рисовальщик молчит: ${results.draw.slowMs} мс`],
    [results.frozen.cached === 200, `хранилище замёрзло, страница из кэша: ${results.frozen.cached}`],
    [
      results.frozen.cold === 503 && results.frozen.coldMs <= THRESHOLDS.frozenColdMs,
      `хранилище замёрзло, без кэша: ${results.frozen.cold} за ${results.frozen.coldMs} мс`,
    ],
  ];
  return checks.filter(([ok]) => !ok).map(([, text]) => text);
}

await ensureBucket();
const hashes = await seedBlobs();
await Promise.all(SHOPS.map((shop) => seedShop(shop, hashes)));
compose('restart', 'proxy');
await new Promise((resolve) => setTimeout(resolve, 1500));
const results = { load: {} };
await measureLoad(results);
results.steady = await steadyLatency(SHOPS[0]);
results.steady = { median: round(results.steady.median), p95: round(results.steady.p95) };
line(
  `время ответа (${SHOPS[0].rows} строк, ${REQUESTS} запросов по ${CONCURRENCY}): медиана ${results.steady.median} мс, p95 ${results.steady.p95} мс`,
);
await measureDraw(results);
await measureFrozenStorage(results);
const failed = failures(results);
line(failed.length === 0 ? 'проба прошла' : `проба не прошла: ${failed.join('; ')}`);
AGENT.destroy();
process.exitCode = failed.length === 0 ? 0 : 1;
