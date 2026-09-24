import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

type WorkerEvent = {
  request: Request;
  respondWith(response: Promise<unknown>): void;
};

test("gateway worker preserves Scriberr handling while bypassing /sidecarr", async () => {
  const listeners = new Map<string, Array<(event: WorkerEvent) => void>>();
  const importedScripts: string[] = [];
  const networkRequests: string[] = [];
  let scriberrHandlerCalls = 0;

  const self = {
    location: { origin: "https://scriberr.example.com" },
    addEventListener(type: string, listener: (event: WorkerEvent) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }
  };

  const context = vm.createContext({
    self,
    URL,
    fetch: async (request: Request) => {
      networkRequests.push(request.url);
      return new Response("network");
    },
    importScripts: (...urls: string[]) => {
      importedScripts.push(...urls);
      self.addEventListener("fetch", () => { scriberrHandlerCalls += 1; });
    }
  });

  const source = readFileSync(new URL("../router/sw-wrapper.js", import.meta.url), "utf8");
  vm.runInContext(source, context);

  async function dispatch(path: string) {
    let stopped = false;
    let response: Promise<unknown> | undefined;
    const event: WorkerEvent = {
      request: new Request(`https://scriberr.example.com${path}`),
      respondWith(nextResponse) {
        stopped = true;
        response = nextResponse;
      }
    };
    for (const listener of listeners.get("fetch") ?? []) {
      listener(event);
      if (stopped) break;
    }
    await response;
  }

  await dispatch("/sidecarr/jobs");
  assert.deepEqual(networkRequests, ["https://scriberr.example.com/sidecarr/jobs"]);
  assert.equal(scriberrHandlerCalls, 0);

  await dispatch("/audio/example");
  assert.equal(scriberrHandlerCalls, 1);
  assert.deepEqual(importedScripts, ["/__scriberr_original_sw.js"]);
});
