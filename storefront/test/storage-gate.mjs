// Задвижка между раздачей и хранилищем стенда (compose.test.yml): ответы хранилища идут насквозь, кроме одного
// объекта, который тест попросил задержать. Задержанный ответ уже прочитан из хранилища — раздача получит то, что
// там лежало до задержки, — и уходит, когда тест его отпустит. Так тест переключения указателя ставит гонку руками.
// Управление на своём порту: POST /hold?path=<путь объекта> — задержать следующий ответ по этому пути;
// GET /held — задержан ли ответ; POST /release — отпустить; GET /health.
import { createServer, request } from 'node:http';

const PORT = 9000;
const CONTROL_PORT = 8080;
const STORAGE = { host: 'storage', port: 9000 };

let armed = null;
let held = null;

function forward(incoming, outgoing) {
  const options = { ...STORAGE, method: incoming.method, path: incoming.url, headers: incoming.headers };
  const upstream = request(options, (reply) => {
    if (armed !== null && incoming.url === armed) return holdReply(reply, outgoing);
    outgoing.writeHead(reply.statusCode, reply.headers);
    return reply.pipe(outgoing);
  });
  upstream.on('error', () => outgoing.writeHead(502).end());
  incoming.pipe(upstream);
}

function holdReply(reply, outgoing) {
  armed = null;
  const chunks = [];
  reply.on('data', (chunk) => chunks.push(chunk));
  reply.on('end', () => {
    held = () => outgoing.writeHead(reply.statusCode, reply.headers).end(Buffer.concat(chunks));
  });
}

const CONTROL = {
  'POST /hold': (url, response) => {
    armed = url.searchParams.get('path');
    response.end('ok\n');
  },
  'GET /held': (url, response) => response.end(JSON.stringify({ held: held !== null })),
  'POST /release': (url, response) => {
    if (held !== null) held();
    held = null;
    response.end('ok\n');
  },
  'GET /health': (url, response) => response.end('ok\n'),
};

createServer(forward).listen(PORT);

createServer((incoming, response) => {
  const url = new URL(incoming.url, 'http://gate');
  const handler = CONTROL[`${incoming.method} ${url.pathname}`];
  if (handler === undefined) return response.writeHead(404).end();
  return handler(url, response);
}).listen(CONTROL_PORT);
