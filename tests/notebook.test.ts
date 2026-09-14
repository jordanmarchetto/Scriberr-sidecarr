import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { loadConfig, type Config } from "../src/config.ts";
import { StateStore } from "../src/db.ts";
import { NotebookService } from "../src/notebook-service.ts";
import { blockText, type NotionObject, NotionClient, parseNotionPageId } from "../src/notion-client.ts";
import { NotionPublisher } from "../src/notion-publisher.ts";
import { ScriberrApi } from "../src/scriberr-api.ts";
import type { ScriberrJob, ScriberrSummary } from "../src/types.ts";

const jobId = "123e4567-e89b-12d3-a456-426614174000";
const parentCompact = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const parentId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const logger = pino({ level: "silent" });

function config(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_PUBLIC_URL: "http://scriberr.example.test",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    SIDECARR_NOTEBOOK_PROVIDER: "notion",
    SIDECARR_NOTION_TOKEN: "notion-secret",
    SIDECARR_NOTION_PARENT_PAGE_URL: `https://www.notion.so/Scriberr-${parentCompact}`,
    SIDECARR_NOTION_BACKFILL: "true",
    ...overrides
  });
}

class FakeScriberrApi extends ScriberrApi {
  summaryContent = "# Summary\n\n- useful item";
  summaryLookups = 0;
  audioLength = 4;

  override async getSummary(job: string): Promise<ScriberrSummary> {
    this.summaryLookups += 1;
    return { transcription_id: job, content: this.summaryContent };
  }

  override async getAudio(): Promise<Response> {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    return new Response(bytes, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(this.audioLength),
        "Content-Disposition": "attachment; filename=recording.mp3"
      }
    });
  }
}

class FakeNotion {
  private sequence = 0;
  readonly pages = new Map<string, NotionObject>();
  readonly childBlocks = new Map<string, NotionObject[]>();
  createFailures = 0;
  updateTitleFailures = 0;
  uploadsCreated = 0;

  constructor() {
    this.pages.set(parentId, { id: parentId, url: `https://notion.so/${parentCompact}`, in_trash: false });
    this.childBlocks.set(parentId, []);
  }

  async retrievePage(pageId: string): Promise<NotionObject> {
    const page = this.pages.get(pageId);
    if (!page) throw new Error("page not found");
    return page;
  }

  async createPage(parentPageId: string, title: string, children: Array<Record<string, unknown>> = []): Promise<NotionObject> {
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error("temporary Notion outage");
    }
    const id = this.id("page");
    const page: NotionObject = { id, url: `https://notion.so/${id}`, title, parent: parentPageId, in_trash: false };
    this.pages.set(id, page);
    this.childBlocks.set(id, []);
    this.childBlocks.get(parentPageId)?.push({ id, type: "child_page", child_page: { title } });
    if (children.length) await this.appendChildren(id, children);
    return page;
  }

  async updatePageTitle(pageId: string, title: string): Promise<void> {
    if (this.updateTitleFailures > 0) {
      this.updateTitleFailures -= 1;
      throw new Error("temporary title update outage");
    }
    const page = await this.retrievePage(pageId);
    page.title = title;
    for (const blocks of this.childBlocks.values()) {
      const child = blocks.find((block) => block.id === pageId && block.type === "child_page");
      if (child) child.child_page = { title };
    }
  }

  async movePage(pageId: string, newParentId: string): Promise<void> {
    for (const blocks of this.childBlocks.values()) {
      const index = blocks.findIndex((block) => block.id === pageId && block.type === "child_page");
      if (index >= 0) blocks.splice(index, 1);
    }
    const page = await this.retrievePage(pageId);
    page.parent = newParentId;
    this.childBlocks.get(newParentId)?.push({ id: pageId, type: "child_page", child_page: { title: page.title } });
  }

  async children(blockId: string): Promise<NotionObject[]> {
    return (this.childBlocks.get(blockId) ?? []).filter((block) => block.in_trash !== true);
  }

  async appendChildren(blockId: string, children: Array<Record<string, unknown>>): Promise<NotionObject[]> {
    const created = children.map((block) => this.createBlock(block));
    const existing = this.childBlocks.get(blockId) ?? [];
    existing.push(...created);
    this.childBlocks.set(blockId, existing);
    return created;
  }

  async updateBlock(blockId: string, body: Record<string, unknown>): Promise<void> {
    const block = this.findBlock(blockId);
    if (!block) throw new Error("block not found");
    Object.assign(block, body);
  }

  async trashBlock(blockId: string): Promise<void> {
    const block = this.findBlock(blockId);
    if (block) block.in_trash = true;
  }

  async createFileUpload(): Promise<NotionObject> {
    this.uploadsCreated += 1;
    return { id: this.id("upload") };
  }

  async sendFileUpload(): Promise<void> {}

  findBlockForTest(id: string): NotionObject | undefined {
    return this.findBlock(id);
  }

  addParent(pageId: string): void {
    this.pages.set(pageId, { id: pageId, url: `https://notion.so/${pageId.replace(/-/g, "")}`, in_trash: false });
    this.childBlocks.set(pageId, []);
  }

  private createBlock(input: Record<string, unknown>): NotionObject {
    const block: NotionObject = { ...input, id: this.id("block") };
    const type = typeof block.type === "string" ? block.type : "";
    const value = type ? block[type] : undefined;
    if (value && typeof value === "object") {
      const content = { ...(value as Record<string, unknown>) };
      const nested = Array.isArray(content.children) ? content.children as Array<Record<string, unknown>> : [];
      delete content.children;
      block[type] = content;
      if (nested.length) {
        const children = nested.map((item) => this.createBlock(item));
        this.childBlocks.set(block.id, children);
      }
    }
    return block;
  }

  private findBlock(id: string): NotionObject | undefined {
    for (const blocks of this.childBlocks.values()) {
      const block = blocks.find((item) => item.id === id);
      if (block) return block;
    }
    return undefined;
  }

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }
}

function scenario(): { config: Config; db: StateStore; directory: string; notion: FakeNotion; api: FakeScriberrApi } {
  const directory = mkdtempSync(path.join(tmpdir(), "scriberr-sidecarr-notebook-"));
  const value = config({ SIDECARR_DB_PATH: path.join(directory, "state.db") });
  return {
    config: value,
    db: new StateStore(value.dbPath),
    directory,
    notion: new FakeNotion(),
    api: new FakeScriberrApi(value)
  };
}

test("validates optional Notion configuration and parses parent page URLs", () => {
  const disabled = loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt"
  });
  assert.equal(disabled.notebookProvider, undefined);
  assert.equal(disabled.scriberrPublicUrl, "http://scriberr");
  assert.equal(config().scriberrPublicUrl, "http://scriberr.example.test");
  assert.throws(() => loadConfig({
    SIDECARR_SCRIBERR_URL: "http://scriberr",
    SIDECARR_SCRIBERR_API_KEY: "api-key",
    SIDECARR_MQTT_URL: "mqtt://mqtt",
    SIDECARR_NOTEBOOK_PROVIDER: "notion"
  }), /SIDECARR_NOTION_TOKEN|Notion is enabled/);
  assert.equal(parseNotionPageId(`https://app.notion.com/p/Demo-${parentCompact}`), parentId);
});

test("sends versioned, authenticated Notion page requests without leaking read-only fields", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ id: "page-1", url: "https://notion.so/page-1" });
  };
  const client = new NotionClient("notion-secret", "https://notion.test/v1", fakeFetch, 0);

  await client.createPage(parentId, "Appointment", [{
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: "marker" } }] }
  }]);

  assert.equal(requests[0]?.url, "https://notion.test/v1/pages");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer notion-secret");
  assert.equal(headers.get("Notion-Version"), "2026-03-11");
  const body = String(requests[0]?.init?.body);
  assert.match(body, new RegExp(parentId));
  assert.doesNotMatch(body, /plain_text|notion-secret/);
});

test("creates and progressively updates a page without touching user Notes", async () => {
  const value = scenario();
  try {
    const discovered = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const publisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    const pending: ScriberrJob = {
      id: jobId,
      title: "Therapy appointment",
      status: "pending",
      created_at: "2026-09-12T12:00:00Z",
      audio_path: `/app/data/uploads/${jobId}_recording.mp3`
    };
    const first = await publisher.sync(pending, discovered);
    assert.deepEqual(first.map((item) => item.event), [
      "notebook_page_created",
      "notebook_status_updated",
      "notebook_audio_attached"
    ]);
    const page = value.db.getNotebookPage(jobId, "notion");
    assert.ok(page);
    const topLevel = await value.notion.children(page.page_id);
    const openInScriberr = topLevel.find((block) => blockText(block) === "Open in Scriberr");
    const details = topLevel.find((block) => blockText(block) === "Details");
    assert.ok(openInScriberr);
    assert.match(JSON.stringify(openInScriberr), new RegExp(`http://scriberr.example.test/audio/${jobId}`));
    assert.ok(details);
    assert.equal(topLevel.filter((block) => block.type === "table").length, 0);
    assert.equal(topLevel.some((block) => blockText(block).startsWith("Sidecarr Job ID:")), false);
    assert.equal((await value.notion.children(details.id)).filter((block) => block.type === "table").length, 2);
    const userNote = (await value.notion.appendChildren(page.page_id, [{
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: "Remember this" } }] }
    }]))[0];

    value.db.updateJob(jobId, { sidecar_state: "transcription_complete", scriberr_status: "completed" });
    value.api.summaryContent = "**Overview**\n\n- **Decision:** useful item\n+ Follow up";
    const completedRow = value.db.getJob(jobId)!;
    const completed = await publisher.sync({
      ...pending,
      status: "completed",
      transcript: JSON.stringify({
        text: "hello hi",
        language: "en",
        segments: [
          { start: 0, end: 2.5, text: "hello", speaker: "SPEAKER_00" },
          { start: 2.5, end: 4, text: "hi", speaker: "SPEAKER_01" }
        ]
      }),
      summary: value.api.summaryContent
    }, completedRow);
    assert.ok(completed.some((item) => item.event === "notebook_transcript_updated"));
    assert.ok(completed.some((item) => item.event === "notebook_summary_updated"));
    assert.equal(value.api.summaryLookups, 0);
    assert.equal(value.notion.findBlockForTest(userNote.id)?.in_trash, undefined);
    assert.doesNotMatch(JSON.stringify([...first, ...completed]), /hello|useful item|notion-secret/);

    const transcriptBlocks = await value.notion.children(page.transcript_page_id);
    assert.ok(transcriptBlocks.some((block) => blockText(block).includes("Speaker 1")));
    assert.equal(transcriptBlocks.some((block) => blockText(block).startsWith("Sidecarr Transcript for Job ID:")), false);
    const rawTranscript = transcriptBlocks.find((block) => blockText(block) === "Raw transcript data");
    assert.ok(rawTranscript);
    assert.ok((await value.notion.children(rawTranscript.id)).every((block) => block.type === "code"));

    const summaryBlocks = await value.notion.children(page.summary_container_id);
    assert.doesNotMatch(JSON.stringify(summaryBlocks), /\*\*/);
    assert.match(JSON.stringify(summaryBlocks), /"bold":true/);
    assert.equal(summaryBlocks.filter((block) => block.type === "bulleted_list_item").length, 2);
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("archives a previous attempt and emits durable metadata-only MQTT events", async () => {
  const value = scenario();
  try {
    const row = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const notionPublisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    const service = new NotebookService(value.config, value.db, notionPublisher, logger);
    const job: ScriberrJob = { id: jobId, status: "completed", transcript: "old transcript", summary: "old summary" };
    await service.sync(job, row);

    value.db.updateJob(jobId, { sidecar_state: "transcription_failed", scriberr_status: "failed" });
    const rerun = value.db.startNewAttempt(jobId, "2026-09-12T13:00:00Z");
    await service.sync({ id: jobId, status: "processing" }, rerun);

    const mapping = value.db.getNotebookPage(jobId, "notion");
    assert.equal(mapping?.current_attempt, 2);
    const eventTypes = value.db.pendingEvents().map((event) => event.event_type);
    assert.ok(eventTypes.includes("notebook_version_archived"));
    assert.ok(eventTypes.includes("notebook_page_created"));
    for (const event of value.db.pendingEvents().filter((item) => item.event_type.startsWith("notebook_"))) {
      assert.doesNotMatch(event.payload_json, /old transcript|old summary|notion-secret/);
    }
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("records three page-creation failures without stopping notebook callers", async () => {
  const value = scenario();
  try {
    value.notion.createFailures = 3;
    const row = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const publisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    const outcomes = await publisher.sync({ id: jobId, status: "pending" }, row);
    assert.equal(outcomes[0]?.event, "notebook_sync_failed");
    const operation = value.db.getNotebookOperation(jobId, "notion", "page:create:1:pending");
    assert.equal(operation?.attempts, 3);
    assert.equal(operation?.status, "failed");
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("skips oversized audio and leaves a Scriberr link", async () => {
  const value = scenario();
  try {
    value.api.audioLength = 21 * 1024 * 1024;
    const row = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const publisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );

    const outcomes = await publisher.sync({ id: jobId, status: "pending" }, row);
    const page = value.db.getNotebookPage(jobId, "notion");
    assert.equal(page?.audio_state, "skipped");
    assert.equal(value.notion.uploadsCreated, 0);
    assert.ok(outcomes.some((item) => item.event === "notebook_audio_skipped"));
    const audioText = (await value.notion.children(page!.audio_container_id)).map(blockText).join(" ");
    assert.match(audioText, /20 MiB/);
    assert.match(JSON.stringify(await value.notion.children(page!.audio_container_id)), new RegExp(`/audio/${jobId}`));
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("recovers its page mapping after local state loss without uploading audio twice", async () => {
  const value = scenario();
  try {
    const row = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const firstPublisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    await firstPublisher.sync({ id: jobId, status: "pending" }, row);
    const originalPageId = value.db.getNotebookPage(jobId, "notion")!.page_id;
    assert.equal(value.notion.uploadsCreated, 1);

    value.db.close();
    const recoveredDb = new StateStore(path.join(value.directory, "recovered.db"));
    const recoveredRow = recoveredDb.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const recoveredPublisher = new NotionPublisher(
      value.config,
      recoveredDb,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    await recoveredPublisher.sync({ id: jobId, status: "pending" }, recoveredRow);

    assert.equal(recoveredDb.getNotebookPage(jobId, "notion")?.page_id, originalPageId);
    assert.equal(recoveredDb.getNotebookPage(jobId, "notion")?.audio_state, "attached");
    assert.equal(value.notion.uploadsCreated, 1);
    recoveredDb.close();
  } finally {
    try {
      value.db.close();
    } catch {
      // The state-loss simulation already closed it.
    }
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("moves managed pages when the configured Notion parent changes", async () => {
  const value = scenario();
  try {
    const row = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const firstPublisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    await firstPublisher.sync({ id: jobId, status: "pending" }, row);

    const secondCompact = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const secondParent = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    value.notion.addParent(secondParent);
    const movedPublisher = new NotionPublisher(
      config({
        SIDECARR_DB_PATH: value.config.dbPath,
        SIDECARR_NOTION_PARENT_PAGE_URL: `https://www.notion.so/Scriberr-${secondCompact}`
      }),
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    const outcomes = await movedPublisher.sync({ id: jobId, status: "pending" }, value.db.getJob(jobId)!);

    assert.equal(value.db.getNotebookPage(jobId, "notion")?.parent_page_id, secondParent);
    assert.ok(outcomes.some((item) => item.event === "notebook_page_moved"));
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});

test("does not duplicate a rerun archive when a retry resumes midway", async () => {
  const value = scenario();
  try {
    const row = value.db.discover(jobId, "/watch/job", "2026-09-12T12:00:00Z").job;
    const publisher = new NotionPublisher(
      value.config,
      value.db,
      value.api,
      logger,
      value.notion as unknown as NotionClient
    );
    await publisher.sync({ id: jobId, status: "completed", transcript: "old", summary: "old" }, row);
    value.db.updateJob(jobId, { sidecar_state: "transcription_failed", scriberr_status: "failed" });
    const rerun = value.db.startNewAttempt(jobId, "2026-09-12T13:00:00Z");
    value.notion.updateTitleFailures = 1;

    await publisher.sync({ id: jobId, status: "processing" }, rerun);

    const page = value.db.getNotebookPage(jobId, "notion")!;
    const archives = (await value.notion.children(page.versions_container_id))
      .filter((block) => blockText(block).startsWith("Attempt 1 —"));
    assert.equal(archives.length, 1);
    const currentTranscripts = (await value.notion.children(page.page_id))
      .filter((block) => block.type === "child_page" && JSON.stringify(block).includes("Full Transcript"));
    assert.equal(currentTranscripts.length, 1);
  } finally {
    value.db.close();
    rmSync(value.directory, { recursive: true, force: true });
  }
});
