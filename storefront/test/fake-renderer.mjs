// Подставной рисовальщик для проверок раздачи (design.md блока 5, Св-1 В). GET /draw?shop&build&path&render&theme[&list]:
// версия живой сборки не та (render ≠ RENDER_HASH) — 409; путь /products/slow… — ответ позже тайм-аута раздачи;
// /products/missing… — 404 «такой сущности нет»; остальное — 200 со страницей и её отпечатком в X-Merfy-Hash.
// GET /calls — сколько раз звали рисовальщик и с какими путями.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 8080;
const SLOW_MS = 10_000;
const calls = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Параметры списка (блок 11 «Секций и SDK», часть 11а-2) — в теле страницы, чтобы тест видел, что пришло рисовальщику.
const page = (path, list) =>
  `<!doctype html><title>Дорисована ${path}</title><h1>${path}</h1>${list === null ? '' : `<p data-list>${list}</p>`}`;

const ANSWERS = [
  { when: (query) => query.get('render') !== process.env.RENDER_HASH, status: 409, delay: 0 },
  { when: (query) => query.get('path').startsWith('/products/slow'), status: 200, delay: SLOW_MS },
  { when: (query) => query.get('path').startsWith('/products/missing'), status: 404, delay: 0 },
  // Список (часть 11а-2): q=missing — такой страницы нет, q=slow — ответ позже тайм-аута раздачи.
  { when: (query) => (query.get('list') ?? '').includes('q=missing'), status: 404, delay: 0 },
  { when: (query) => (query.get('list') ?? '').includes('q=slow'), status: 200, delay: SLOW_MS },
  { when: () => true, status: 200, delay: 0 },
];

async function draw(query, response) {
  calls.push(query.get('path'));
  const answer = ANSWERS.find((candidate) => candidate.when(query));
  await wait(answer.delay);
  const body = answer.status === 200 ? page(query.get('path'), query.get('list')) : '';
  const hash = createHash('sha256').update(body).digest('hex');
  response.writeHead(answer.status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Merfy-Hash': hash });
  response.end(body);
}

const ROUTES = {
  '/health': (query, response) => response.end('ok\n'),
  '/calls': (query, response) => response.end(JSON.stringify({ count: calls.length, paths: calls })),
  '/draw': draw,
};

createServer((request, response) => {
  const url = new URL(request.url, 'http://renderer');
  const handler = ROUTES[url.pathname];
  if (handler === undefined) return response.writeHead(404).end();
  return handler(url.searchParams, response);
}).listen(PORT);
