import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].text, "4");
  assert.equal(result[7].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-gemini-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("search results received after 845 ms reach Gemini and both calls are logged", async t => {
  const handler = (await import("../api/index.js")).default;
  for (const key of ["SERPER_API_KEY", "GEMINI_API_KEY", "GEMINI_MODEL"]) {
    const originalValue = process.env[key];
    process.env[key] = "test";
    t.after(() => {
      if (originalValue === undefined) delete process.env[key];
      else process.env[key] = originalValue;
    });
  }

  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const info = t.mock.method(console, "info", () => {});
  const fetch = t.mock.method(globalThis, "fetch", async (url, { signal }) => {
    if (url === "https://google.serper.dev/search") {
      t.mock.timers.tick(845);
      signal.throwIfAborted();
      return Response.json({ answerBox: { answer: "В Москве 5 градусов." } });
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: "Сейчас 5 градусов." }] } }] });
  });

  const reply = await handler({ method: "POST", body: { request: { command: "Какая погода в Москве?" } } }, {
    status(code) { assert.equal(code, 200); return this; },
    json(value) { return value; }
  });

  assert.equal(fetch.mock.callCount(), 2);
  const geminiBody = JSON.parse(fetch.mock.calls[1].arguments[1].body);
  assert.match(geminiBody.contents.at(-1).parts[0].text, /В Москве 5 градусов/);
  assert.equal(reply.response.text, "Сейчас 5 градусов.");

  const [serper, gemini, alice] = info.mock.calls.map(call => JSON.parse(call.arguments[0]));
  assert.equal(serper.event, "serper.request");
  assert.equal(serper.timeoutMs, 1300);
  assert.equal(gemini.event, "gemini.request");
  assert.equal(gemini.timeoutMs, 3155);
  assert.equal(gemini.status, 200);
  assert.equal(alice.event, "alice.response");
  assert.equal(alice.outcome, "answered");
  assert.equal(alice.searchContextUsed, true);
});
