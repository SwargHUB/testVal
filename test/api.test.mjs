import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { startServer } from "../server.mjs";

let server;
let baseUrl;

before(async () => {
  server = await startServer({ port: 0 });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
});

async function postRaw(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

function postJson(payload) {
  return postRaw(JSON.stringify(payload));
}

async function assertManualReview(body) {
  assert.equal(body.status, "manual_review");
  assert.equal(body.topic, null);
  assert.equal(body.draft, null);
}

test("корректная заявка возвращает тему и непустой черновик", async () => {
  const { status, body } = await postJson({ text: "Когда будет доставка моего заказа?" });

  assert.equal(status, 200);
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0);
});

test("имитатор определяет тему pricing", async () => {
  const { body } = await postJson({ text: "Интересует стоимость обслуживания" });

  assert.equal(body.status, "ready");
  assert.equal(body.topic, "pricing");
});

test("неизвестная заявка получает тему other", async () => {
  const { body } = await postJson({ text: "Когда открыты офисы?" });

  assert.equal(body.status, "ready");
  assert.equal(body.topic, "other");
});

test("пустой ввод отклоняется с invalid_input", async () => {
  const { status, body } = await postJson({ text: "" });

  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("ввод из пробелов отклоняется с invalid_input", async () => {
  const { status, body } = await postJson({ text: "   \n  " });

  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("отсутствующее поле text отклоняется с invalid_input", async () => {
  const { status, body } = await postJson({ query: "доставка" });

  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("нестроковый ввод отклоняется с invalid_input", async () => {
  const { status, body } = await postJson({ text: 42 });

  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("битый JSON отклоняется с invalid_input", async () => {
  const { status, body } = await postRaw('{"text": ');

  assert.equal(status, 400);
  assert.deepEqual(body, { status: "invalid_input" });
});

test("таймаут модели переводит заявку в ручной разбор", async () => {
  const startedAt = Date.now();
  const { status, body } = await postJson({ text: "[timeout] клиент ждёт ответа" });
  const elapsed = Date.now() - startedAt;

  assert.equal(status, 200);
  await assertManualReview(body);
  assert.ok(elapsed < 1000, `сервер ждал ${elapsed} мс вместо лимита 300 мс`);
});

test("ошибка модели переводит заявку в ручной разбор", async () => {
  const { status, body } = await postJson({ text: "[error] провайдер недоступен" });

  assert.equal(status, 200);
  await assertManualReview(body);
});

test("невалидный JSON модели переводит заявку в ручной разбор", async () => {
  const { status, body } = await postJson({ text: "[bad-json] ответ не в JSON" });

  assert.equal(status, 200);
  await assertManualReview(body);
});

test("неизвестная тема модели переводит заявку в ручной разбор", async () => {
  const { status, body } = await postJson({ text: "[bad-topic] доставка заказа" });

  assert.equal(status, 200);
  await assertManualReview(body);
});

test("пустой черновик модели переводит заявку в ручной разбор", async () => {
  const { status, body } = await postJson({ text: "[empty-draft] стоимость доставки" });

  assert.equal(status, 200);
  await assertManualReview(body);
});

test("неизвестный маршрут отвечает 404", async () => {
  const response = await fetch(`${baseUrl}/api/unknown`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: "not_found" });
});

test("главная страница отдаётся как HTML", async () => {
  const response = await fetch(`${baseUrl}/`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
});
