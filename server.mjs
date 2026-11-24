import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { classify } from "./mock-ai.mjs";

const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractText(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const { text } = payload;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

function normalizeModelOutput(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { topic, draft } = parsed;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

async function requestModel(text) {
  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("model_timeout"));
      }, MODEL_TIMEOUT_MS);
    });
    const raw = await Promise.race([classify(text, { signal: controller.signal }), timeout]);
    return normalizeModelOutput(raw);
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }

  const text = extractText(payload);
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let output = null;
  try {
    output = await requestModel(text);
  } catch {
    output = null;
  }

  if (!output) return json(response, 200, { status: "manual_review", topic: null, draft: null });
  return json(response, 200, { status: "ready", topic: output.topic, draft: output.draft });
}

export function createTriageServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (request.method === "POST" && request.url === "/api/triage") {
        await handleTriage(request, response);
        return;
      }
      json(response, 404, { status: "not_found" });
    } catch {
      if (!response.headersSent) json(response, 500, { status: "server_error" });
      else response.end();
    }
  });
}

export async function startServer({ port = Number(process.env.PORT || 3000), host = "127.0.0.1" } = {}) {
  const server = createTriageServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  return server;
}

const entryPoint = process.argv[1] ? resolve(process.argv[1]) : "";
const isDirectRun = entryPoint === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const server = await startServer();
  const { port } = server.address();
  console.log(`Входящие заявки: http://127.0.0.1:${port}`);
  server.on("error", (error) => {
    console.error(`Ошибка сервера: ${error.message}`);
  });
}
