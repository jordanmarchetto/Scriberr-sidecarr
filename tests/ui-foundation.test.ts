import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { ScriberrBrowserAuth } from "../src/browser-auth.ts";
import { loadConfig } from "../src/config.ts";
import { ConfigurationManager } from "../src/configuration-manager.ts";
import { StateStore } from "../src/db.ts";
import { Metrics } from "../src/metrics.ts";
import { UiServer } from "../src/ui-server.ts";
import { WebhookReceiver } from "../src/webhook-receiver.ts";

const uiRoot = path.resolve("ui-dist");
const logger = pino({ level: "silent" });

function scenario(env: NodeJS.ProcessEnv = {}): {
  config: ReturnType<typeof loadConfig>;
  configuration: ConfigurationManager;
  db: StateStore;
  directory: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "sidecarr-ui-"));
  const completeEnv = {
    SIDECARR_SCRIBERR_URL: "http://scriberr.test",
    SIDECARR_SCRIBERR_API_KEY: "worker-key",
    SIDECARR_DB_PATH: path.join(directory, "state.db"),
    ...env
  };
  const config = loadConfig(completeEnv);
  const db = new StateStore(config.dbPath);
  return { config, configuration: new ConfigurationManager(completeEnv, db), db, directory };
}

async function withServer(
  value: ReturnType<typeof scenario>,
  request: typeof fetch,
  work: (origin: string) => Promise<void>
): Promise<void> {
  const auth = new ScriberrBrowserAuth(() => value.configuration.current.config, request);
  const ui = new UiServer(() => value.configuration.current.config, value.configuration, auth, logger, uiRoot);
  const receiver = new WebhookReceiver(value.config, value.db, () => undefined, logger, new Metrics(), () => "ready", ui);
  try {
    await receiver.listen(0, "127.0.0.1");
    await work(`http://127.0.0.1:${receiver.port()}`);
  } finally {
    await receiver.close();
    value.configuration.close();
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
}

test("browser authentication delegates bearer and cookie sessions without accepting an API key", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  const request: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({ ok: true });
  };
  const config = loadConfig({ SIDECARR_SCRIBERR_URL: "http://scriberr.test", SIDECARR_SCRIBERR_API_KEY: "worker" });
  const auth = new ScriberrBrowserAuth(() => config, request);

  assert.deepEqual(await auth.authenticate({ authorization: "Bearer browser-token", "x-api-key": "worker" }), {
    status: "authenticated",
    authorization: "Bearer browser-token"
  });
  assert.equal(requests[0]?.url, "http://scriberr.test/api/v1/api-keys/");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer browser-token");
  assert.equal(requests[0]?.headers.get("x-api-key"), null);

  assert.deepEqual(await auth.authenticate({ cookie: "scriberr_access_token=cookie-token" }), { status: "authenticated" });
  assert.match(requests[1]?.url ?? "", /transcription\/list/);
  assert.equal(requests[1]?.headers.get("cookie"), "scriberr_access_token=cookie-token");

  const before = requests.length;
  assert.deepEqual(await auth.authenticate({ "x-api-key": "worker" }), { status: "unauthenticated" });
  assert.equal(requests.length, before);

  const rejected = new ScriberrBrowserAuth(() => config, async () => Response.json({ error: "expired" }, { status: 401 }));
  assert.deepEqual(await rejected.authenticate({ authorization: "Bearer expired" }), { status: "unauthenticated" });
  const offline = new ScriberrBrowserAuth(() => config, async () => { throw new Error("offline"); });
  assert.deepEqual(await offline.authenticate({ authorization: "Bearer token" }), { status: "unavailable" });
});

test("API-key creation reports Scriberr failures without exposing a key", async () => {
  const config = loadConfig({ SIDECARR_SCRIBERR_URL: "http://scriberr.test", SIDECARR_SCRIBERR_API_KEY: "worker" });
  const rejected = new ScriberrBrowserAuth(() => config, async () => Response.json({ error: "no" }, { status: 500 }));
  await assert.rejects(rejected.createBackgroundApiKey("Bearer browser-token"), /HTTP 500/);
  const malformed = new ScriberrBrowserAuth(() => config, async () => Response.json({ id: 1 }));
  await assert.rejects(malformed.createBackgroundApiKey("Bearer browser-token"), /invalid API-key response/);
});

test("UI session endpoints distinguish unauthenticated, unavailable, and complete setups", async () => {
  const value = scenario();
  let unavailable = false;
  const request: typeof fetch = async (_input, init) => {
    if (unavailable) throw new Error("offline");
    const headers = new Headers(init?.headers);
    if (headers.has("authorization") || headers.get("x-api-key") === "worker-key") return Response.json({ ok: true });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  };
  await withServer(value, request, async (origin) => {
    assert.equal((await fetch(`${origin}/sidecarr/api/session`)).status, 401);
    const authenticated = await fetch(`${origin}/sidecarr/api/session`, { headers: { Authorization: "Bearer browser-token" } });
    assert.equal(authenticated.status, 200);
    const body = await authenticated.json() as { setup: { required: boolean; source: string; credentialStatus: string } };
    assert.deepEqual(body.setup, { required: false, manageable: false, source: "environment", credentialStatus: "valid" });
    unavailable = true;
    assert.equal((await fetch(`${origin}/sidecarr/api/session`, { headers: { Authorization: "Bearer browser-token" } })).status, 503);
  });
});

test("API-key setup requires browser auth and same-origin mutation protection", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sidecarr-setup-"));
  const env = { SIDECARR_SCRIBERR_URL: "http://scriberr.test", SIDECARR_DB_PATH: path.join(directory, "state.db") };
  const db = new StateStore(env.SIDECARR_DB_PATH);
  const configuration = new ConfigurationManager(env, db);
  const config = configuration.current.config;
  let activations = 0;
  configuration.registerActivator("scriberr", () => { activations += 1; });
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/api-keys/") && init?.method === "POST") {
      return Response.json({ key: "new-worker-key" });
    }
    if (new Headers(init?.headers).has("authorization")) return Response.json({ api_keys: [] });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  };
  const auth = new ScriberrBrowserAuth(() => configuration.current.config, request);
  const ui = new UiServer(() => configuration.current.config, configuration, auth, logger, uiRoot);
  const receiver = new WebhookReceiver(config, db, () => undefined, logger, new Metrics(), () => "configuration_required", ui);
  try {
    await receiver.listen(0, "127.0.0.1");
    const origin = `http://127.0.0.1:${receiver.port()}`;
    const endpoint = `${origin}/sidecarr/api/setup/api-key`;
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Authorization: "Bearer browser-token" } })).status, 403);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: "https://evil.test", Authorization: "Bearer browser-token", "X-Sidecarr-Request": "1" } })).status, 403);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: origin, "X-Sidecarr-Request": "1" } })).status, 401);
    const created = await fetch(endpoint, { method: "POST", headers: { Origin: origin, Authorization: "Bearer browser-token", "X-Sidecarr-Request": "1" } });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { configured: true, active: true, restartRequired: false });
    assert.equal(configuration.current.config.scriberrApiKey, "new-worker-key");
    assert.equal(activations, 1);
    db.close();
    const reopened = new StateStore(env.SIDECARR_DB_PATH);
    assert.equal(new ConfigurationManager(env, reopened).current.config.scriberrApiKey, "new-worker-key");
    reopened.close();
  } finally {
    await receiver.close();
    configuration.close();
    try { db.close(); } catch { /* already closed for persistence verification */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("environment-owned API keys cannot be replaced from the UI", async () => {
  const value = scenario();
  let created = false;
  const request: typeof fetch = async (_input, init) => {
    if (init?.method === "POST") created = true;
    return Response.json({ api_keys: [] });
  };
  await withServer(value, request, async (origin) => {
    const response = await fetch(`${origin}/sidecarr/api/setup/api-key`, {
      method: "POST",
      headers: { Origin: origin, Authorization: "Bearer browser-token", "X-Sidecarr-Request": "1" }
    });
    assert.equal(response.status, 409);
    assert.equal(created, false);
  });
});

test("base-path assets and client routes are served without intercepting webhooks", async () => {
  const value = scenario({ SIDECARR_WEBHOOK_SECRET: "webhook-secret" });
  const request: typeof fetch = async () => Response.json({ ok: true });
  await withServer(value, request, async (origin) => {
    const redirect = await fetch(`${origin}/sidecarr`, { redirect: "manual" });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/sidecarr/");
    const index = await fetch(`${origin}/sidecarr/jobs`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /content="\/sidecarr"/);
    const cssName = readFileSync(path.join(uiRoot, "index.html"), "utf8").match(/\.\/assets\/([^"']+\.css)/)?.[1];
    assert.ok(cssName);
    assert.match(await (await fetch(`${origin}/sidecarr/assets/${cssName}`)).text(), /@media \(width<=420px\)/);

    const payload = JSON.stringify({ schema_version: "1", event: "recording.uploaded", job_id: "job-1", status: "uploaded", occurred_at: new Date().toISOString() });
    const signature = createHmac("sha256", "webhook-secret").update(payload).digest("hex");
    const webhook = await fetch(`${origin}/webhooks/scriberr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Scriberr-Delivery": "delivery-ui-test", "X-Scriberr-Signature": `sha256=${signature}` },
      body: payload
    });
    assert.equal(webhook.status, 202);
  });
});
