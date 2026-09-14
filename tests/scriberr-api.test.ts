import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { Writable } from "node:stream";
import pino from "pino";
import { loadConfig } from "../src/config.ts";
import { Metrics } from "../src/metrics.ts";
import { ScriberrApi, ScriberrApiError } from "../src/scriberr-api.ts";

function captureLogger(): { logger: pino.Logger; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      records.push(JSON.parse(chunk.toString()));
      callback();
    }
  });
  return { logger: pino({ level: "debug" }, stream), records };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("retries transient Scriberr GET failures with bounded backoff", async () => {
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts += 1;
    if (attempts < 3) {
      response.writeHead(503);
      response.end("temporarily unavailable");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ id: "job-1", status: "completed" }));
  });

  try {
    const url = await listen(server);
    const captured = captureLogger();
    const api = new ScriberrApi(loadConfig({
      SIDECARR_SCRIBERR_URL: url,
      SIDECARR_SCRIBERR_API_KEY: "api-key",
      SIDECARR_MQTT_URL: "mqtt://mqtt",
      SIDECARR_API_MAX_ATTEMPTS: "3",
      SIDECARR_API_RETRY_BASE_MILLISECONDS: "1"
    }), new Metrics(), captured.logger);

    const job = await api.getJob("job-1");
    assert.equal(job.status, "completed");
    assert.equal(attempts, 3);
    const retryLogs = captured.records.filter((record) => record.msg === "Scriberr API request failed; retrying");
    assert.equal(retryLogs.length, 2);
    assert.equal(retryLogs[0].status, 503);
    assert.equal(retryLogs[0].attempt, 1);
    assert.equal(retryLogs[0].maxAttempts, 3);
    assert.equal(captured.records.at(-1)?.msg, "Scriberr API request recovered after retry");
    assert.doesNotMatch(JSON.stringify(captured.records), /api-key/);
  } finally {
    await close(server);
  }
});

test("does not retry permanent Scriberr client errors", async () => {
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts += 1;
    response.writeHead(400);
    response.end("invalid request");
  });

  try {
    const url = await listen(server);
    const api = new ScriberrApi(loadConfig({
      SIDECARR_SCRIBERR_URL: url,
      SIDECARR_SCRIBERR_API_KEY: "api-key",
      SIDECARR_MQTT_URL: "mqtt://mqtt",
      SIDECARR_API_MAX_ATTEMPTS: "3",
      SIDECARR_API_RETRY_BASE_MILLISECONDS: "1"
    }));

    await assert.rejects(() => api.getJob("job-1"), ScriberrApiError);
    assert.equal(attempts, 1);
  } finally {
    await close(server);
  }
});

test("availability check treats a missing health route as reachable Scriberr", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });

  try {
    const url = await listen(server);
    const api = new ScriberrApi(loadConfig({
      SIDECARR_SCRIBERR_URL: url,
      SIDECARR_SCRIBERR_API_KEY: "api-key"
    }));
    assert.equal(await api.isAvailable(), true);
  } finally {
    await close(server);
  }
});

test("availability check reports an unreachable Scriberr without API retries", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });

  try {
    const url = await listen(server);
    const api = new ScriberrApi(loadConfig({
      SIDECARR_SCRIBERR_URL: url,
      SIDECARR_SCRIBERR_API_KEY: "api-key"
    }));
    assert.equal(await api.isAvailable(), false);
  } finally {
    await close(server);
  }
});
