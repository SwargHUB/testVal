import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scriptSource = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(scriptSource, "в index.html нет инлайнового модуля страницы");

function createElement() {
  const handlers = new Map();
  return {
    value: "",
    hidden: false,
    textContent: "",
    disabled: false,
    dataset: {},
    handlers,
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    focus() {
      this.focused = true;
    },
  };
}

function createDom() {
  const elements = new Map();
  return {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    },
    get(selector) {
      return this.querySelector(selector);
    },
  };
}

function createPage() {
  const dom = createDom();
  const requests = [];
  let nextResponse = { status: 200, payload: { status: "ready", topic: "delivery", draft: "Черновик" } };

  const sandbox = {
    document: dom,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout,
    clearTimeout,
    AbortController,
    console,
    fetch: async (url, options) => {
      requests.push({ url, body: options.body });
      return {
        ok: nextResponse.status < 400,
        status: nextResponse.status,
        text: async () => JSON.stringify(nextResponse.payload),
      };
    },
  };

  vm.runInNewContext(scriptSource, sandbox, { filename: "index.html#script" });

  const form = dom.get("#triage-form");
  const submit = form.handlers.get("submit");
  assert.ok(submit, "обработчик submit не зарегистрирован");

  return {
    dom,
    requests,
    respondWith(status, payload) {
      nextResponse = { status, payload };
    },
    async submitText(text) {
      dom.get("#message").value = text;
      await submit({ preventDefault() {} });
    },
  };
}

test("при успехе страница показывает тему и черновик", async () => {
  const page = createPage();
  await page.submitText("Когда будет доставка заказа?");

  assert.equal(page.dom.get("#output").dataset.state, "ready");
  assert.equal(page.dom.get("#topic").textContent, "Доставка");
  assert.equal(page.dom.get("#draft").textContent, "Черновик");
  assert.equal(page.dom.get("#draft-field").hidden, false);
});

test("при ручном разборе предыдущий черновик очищается", async () => {
  const page = createPage();

  await page.submitText("Когда будет доставка заказа?");
  assert.equal(page.dom.get("#draft").textContent, "Черновик");
  assert.equal(page.dom.get("#draft-field").hidden, false);

  page.respondWith(200, { status: "manual_review", topic: null, draft: null });
  await page.submitText("[timeout] клиент ждёт ответа");

  assert.equal(page.dom.get("#output").dataset.state, "manual_review");
  assert.match(page.dom.get("#status").textContent, /ручной разбор/);
  assert.equal(page.dom.get("#draft").textContent, "", "старый черновик не очищен");
  assert.equal(page.dom.get("#draft-field").hidden, true, "поле черновика не скрыто");
  assert.equal(page.dom.get("#topic").textContent, "");
  assert.equal(page.dom.get("#request-copy").textContent, "[timeout] клиент ждёт ответа");
  assert.equal(page.dom.get("#request-field").hidden, false);
});

test("сетевая ошибка тоже очищает предыдущий черновик", async () => {
  const page = createPage();

  await page.submitText("Когда будет доставка заказа?");
  assert.equal(page.dom.get("#draft").textContent, "Черновик");

  page.respondWith(500, { status: "server_error" });
  await page.submitText("[error] провайдер недоступен");

  assert.equal(page.dom.get("#output").dataset.state, "manual_review");
  assert.equal(page.dom.get("#draft").textContent, "", "старый черновик не очищен");
  assert.equal(page.dom.get("#draft-field").hidden, true);
});

test("пустой ввод не уходит на сервер и очищает результат", async () => {
  const page = createPage();

  await page.submitText("Когда будет доставка заказа?");
  const requestsBefore = page.requests.length;

  await page.submitText("   ");

  assert.equal(page.requests.length, requestsBefore, "пустая заявка отправлена на сервер");
  assert.equal(page.dom.get("#output").dataset.state, "invalid_input");
  assert.equal(page.dom.get("#draft").textContent, "");
  assert.equal(page.dom.get("#draft-field").hidden, true);
});
