import { createHash } from "node:crypto";
import path from "node:path";
import pino from "pino";
import type { Config } from "./config.js";
import { type NotebookPageRow, StateStore } from "./db.js";
import { sanitizeError } from "./errors.js";
import type { NotebookOutcome, NotebookPublisher } from "./notebook.js";
import {
  blockText,
  NotionApiError,
  NotionClient,
  type NotionObject,
  parseNotionPageId,
  richText
} from "./notion-client.js";
import { ScriberrApi, ScriberrApiError } from "./scriberr-api.js";
import type { JobRow, ScriberrJob } from "./types.js";

const maxSimpleUploadBytes = 20 * 1024 * 1024;
const classificationRefreshMs = 5 * 60 * 1000;

type Block = Record<string, unknown>;

type PageShell = {
  currentAttempt: number;
  statusBlockId: string;
  metadataTableId: string;
  classificationTableId: string;
  personRowId: string;
  appointmentTypeRowId: string;
  tagsRowId: string;
  reviewStatusRowId: string;
  audioContainerId: string;
  audioBlockId: string | null;
  audioState: "pending" | "attached" | "skipped";
  summaryContainerId: string;
  summaryBlockIds: string[];
  transcriptPageId: string;
  transcriptBlockIds: string[];
  versionsContainerId: string;
};

export class NotionPublisher implements NotebookPublisher {
  readonly provider = "notion";
  readonly parentPageId: string;

  constructor(
    private readonly config: Config,
    private readonly db: StateStore,
    private readonly scriberr: ScriberrApi,
    private readonly logger: pino.Logger,
    private readonly notion = new NotionClient(config.notionToken ?? "")
  ) {
    if (!config.notionParentPageUrl) throw new Error("Notion parent page URL is required");
    this.parentPageId = parseNotionPageId(config.notionParentPageUrl);
  }

  async sync(job: ScriberrJob, row: JobRow): Promise<NotebookOutcome[]> {
    const outcomes: NotebookOutcome[] = [];
    let page = this.db.getNotebookPage(job.id, this.provider);

    if (!page) {
      const outcome = await this.runOperation(
        row,
        `page:create:${row.attempt}:${job.status}`,
        "create_page",
        async () => {
          const recovered = await this.recoverPage(job.id);
          page = recovered ?? await this.createPage(job, row);
          return this.outcome("notebook_page_created", "create_page", `page:${page.page_id}`, page);
        }
      );
      if (outcome) outcomes.push(outcome);
      page = this.db.getNotebookPage(job.id, this.provider);
      if (!page) return outcomes;
    }

    const accessible = await this.runOperation(
      row,
      `page:access:${row.attempt}:${job.status}`,
      "validate_page",
      async () => {
        const remote = await this.notion.retrievePage(page!.page_id);
        if (remote.in_trash === true || remote.archived === true) throw new Error("Notion appointment page was deleted or trashed; restore it before syncing");
        return undefined;
      },
      false,
      true
    );
    if (accessible) outcomes.push(accessible);
    const accessOperation = this.db.getNotebookOperation(row.job_id, this.provider, `page:access:${row.attempt}:${job.status}`);
    if (accessOperation?.status === "failed") return outcomes;

    if (page.parent_page_id !== this.parentPageId) {
      const outcome = await this.runOperation(row, `page:move:${this.parentPageId}`, "move_page", async () => {
        await this.notion.movePage(page!.page_id, this.parentPageId);
        this.db.updateNotebookPage(job.id, this.provider, { parent_page_id: this.parentPageId });
        page = this.db.getNotebookPage(job.id, this.provider)!;
        return this.outcome("notebook_page_moved", "move_page", `move:${this.parentPageId}`, page);
      });
      if (outcome) outcomes.push(outcome);
    }

    if (page.current_attempt < row.attempt) {
      const outcome = await this.runOperation(row, `version:archive:${row.attempt}`, "archive_version", async () => {
        await this.archiveAttempt(page!, row);
        page = this.db.getNotebookPage(job.id, this.provider)!;
        return this.outcome("notebook_version_archived", "archive_version", `archive:${row.attempt - 1}`, page);
      });
      if (outcome) outcomes.push(outcome);
    }

    const title = this.title(job, row);
    const statusHash = hash(`${title}\n${job.status}\n${row.sidecar_state}\n${row.attempt}\n${row.last_error ?? ""}`);
    if (page.last_status !== statusHash || page.last_title !== title) {
      const outcome = await this.runOperation(row, `status:${statusHash}`, "update_status", async () => {
        await this.notion.updatePageTitle(page!.page_id, title);
        await this.notion.updateBlock(page!.status_block_id, paragraphBody(this.statusText(job, row)));
        const metadataRows = await this.notion.children(page!.metadata_table_id);
        const values = [
          ["Recording date", job.created_at ?? row.first_seen_at],
          ["Scriberr status", job.status],
          ["Current attempt", String(row.attempt)],
          ["Scriberr job ID", job.id],
          ["Open in Scriberr", this.scriberrPageUrl(job.id)]
        ];
        for (let index = 0; index < Math.min(metadataRows.length, values.length); index += 1) {
          await this.notion.updateBlock(metadataRows[index].id, tableRowBody(values[index]));
        }
        this.db.updateNotebookPage(job.id, this.provider, { last_status: statusHash, last_title: title });
        page = this.db.getNotebookPage(job.id, this.provider)!;
        return this.outcome("notebook_status_updated", "update_status", `status:${statusHash}`, page);
      });
      if (outcome) outcomes.push(outcome);
    }

    const classificationOutcome = await this.runOperation(
      row,
      `classification:read:${Math.floor(Date.now() / classificationRefreshMs)}`,
      "read_classification",
      async () => {
        await this.captureClassificationEdits(page!);
        return undefined;
      },
      true,
      true
    );
    if (classificationOutcome) outcomes.push(classificationOutcome);

    if (page.audio_state === "pending") {
      const audioOutcome = await this.syncAudio(job, row, page);
      if (audioOutcome) outcomes.push(audioOutcome);
      page = this.db.getNotebookPage(job.id, this.provider)!;
    }

    if (job.status === "completed" && job.transcript?.trim()) {
      const transcript = job.transcript.trim();
      const transcriptHash = hash(transcript);
      if (page.transcript_hash !== transcriptHash) {
        const outcome = await this.runOperation(row, `transcript:${row.attempt}:${transcriptHash}`, "update_transcript", async () => {
          const blocks = textBlocks(transcript);
          const ids = await this.replaceOwnedChildren(page!.transcript_page_id, jsonIds(page!.transcript_block_ids_json), blocks);
          this.db.updateNotebookPage(job.id, this.provider, {
            transcript_block_ids_json: JSON.stringify(ids),
            transcript_hash: transcriptHash
          });
          page = this.db.getNotebookPage(job.id, this.provider)!;
          return this.outcome("notebook_transcript_updated", "update_transcript", `transcript:${row.attempt}:${transcriptHash}`, page);
        });
        if (outcome) outcomes.push(outcome);
      }
    } else if (job.status === "failed") {
      const failedHash = hash(`failed:${row.last_error ?? "transcription failed"}`);
      if (page.transcript_hash !== failedHash) {
        const outcome = await this.runOperation(row, `transcript:${row.attempt}:${failedHash}`, "update_transcript", async () => {
          const ids = await this.replaceOwnedChildren(
            page!.transcript_page_id,
            jsonIds(page!.transcript_block_ids_json),
            [callout(`Transcription failed: ${sanitizeError(row.last_error ?? "Scriberr reported a failure")}`, "⚠️")]
          );
          this.db.updateNotebookPage(job.id, this.provider, {
            transcript_block_ids_json: JSON.stringify(ids),
            transcript_hash: failedHash
          });
          page = this.db.getNotebookPage(job.id, this.provider)!;
          return this.outcome("notebook_transcript_updated", "update_transcript", `transcript:${row.attempt}:${failedHash}`, page);
        });
        if (outcome) outcomes.push(outcome);
      }
    }

    const summary = await this.summaryContent(job);
    if (summary) {
      const summaryHash = hash(summary);
      if (page.summary_hash !== summaryHash) {
        const outcome = await this.runOperation(row, `summary:${row.attempt}:${summaryHash}`, "update_summary", async () => {
          const ids = await this.replaceOwnedChildren(
            page!.summary_container_id,
            jsonIds(page!.summary_block_ids_json),
            markdownBlocks(summary)
          );
          this.db.updateNotebookPage(job.id, this.provider, {
            summary_block_ids_json: JSON.stringify(ids),
            summary_hash: summaryHash
          });
          page = this.db.getNotebookPage(job.id, this.provider)!;
          return this.outcome("notebook_summary_updated", "update_summary", `summary:${row.attempt}:${summaryHash}`, page);
        });
        if (outcome) outcomes.push(outcome);
      }
    } else if (row.sidecar_state === "summary_failed") {
      const failedHash = hash(`failed:${row.last_error ?? "summary failed"}`);
      if (page.summary_hash !== failedHash) {
        const outcome = await this.runOperation(row, `summary:${row.attempt}:${failedHash}`, "update_summary", async () => {
          const ids = await this.replaceOwnedChildren(
            page!.summary_container_id,
            jsonIds(page!.summary_block_ids_json),
            [callout(`Summary failed: ${sanitizeError(row.last_error ?? "Scriberr reported a failure")}`, "⚠️")]
          );
          this.db.updateNotebookPage(job.id, this.provider, {
            summary_block_ids_json: JSON.stringify(ids),
            summary_hash: failedHash
          });
          page = this.db.getNotebookPage(job.id, this.provider)!;
          return this.outcome("notebook_summary_updated", "update_summary", `summary:${row.attempt}:${failedHash}`, page);
        });
        if (outcome) outcomes.push(outcome);
      }
    }

    return outcomes;
  }

  private async createPage(job: ScriberrJob, row: JobRow): Promise<NotebookPageRow> {
    await this.notion.retrievePage(this.parentPageId);
    const remote = await this.notion.createPage(this.parentPageId, this.title(job, row), [
      paragraph(`Sidecarr Job ID: ${job.id}`)
    ]);
    const pageId = remote.id;
    const now = new Date().toISOString();

    const initial = await this.notion.appendChildren(pageId, [
      paragraph(this.statusText(job, row)),
      table([
        ["Recording date", job.created_at ?? row.first_seen_at],
        ["Scriberr status", job.status],
        ["Current attempt", String(row.attempt)],
        ["Scriberr job ID", job.id],
        ["Open in Scriberr", this.scriberrPageUrl(job.id)]
      ]),
      table([
        ["Person", "—"],
        ["Appointment Type", "—"],
        ["Tags", "—"],
        ["Review Status", "Needs review"]
      ]),
      toggle("Audio", [paragraph("Audio loading…")]),
      heading("Notes"),
      paragraph(""),
      toggle("Summary", [paragraph("Waiting for transcription…")])
    ]);
    const status = required(initial[0], "status block");
    const metadata = required(initial[1], "metadata table");
    const classification = required(initial[2], "classification table");
    const audio = required(initial[3], "audio container");
    const summary = required(initial[6], "summary container");
    const classificationRows = await this.notion.children(classification.id);
    if (classificationRows.length < 4) throw new Error("Notion did not create the classification rows");
    const summaryChildren = await this.notion.children(summary.id);

    const transcript = await this.notion.createPage(pageId, "Full Transcript");
    const transcriptBlocks = await this.notion.appendChildren(transcript.id, [
      paragraph(`Sidecarr Transcript for Job ID: ${job.id}`),
      paragraph("Transcription loading…")
    ]);
    const versions = required((await this.notion.appendChildren(pageId, [toggle("Previous Versions")]))[0], "versions container");

    const shell: PageShell = {
      currentAttempt: row.attempt,
      statusBlockId: status.id,
      metadataTableId: metadata.id,
      classificationTableId: classification.id,
      personRowId: classificationRows[0].id,
      appointmentTypeRowId: classificationRows[1].id,
      tagsRowId: classificationRows[2].id,
      reviewStatusRowId: classificationRows[3].id,
      audioContainerId: audio.id,
      audioBlockId: null,
      audioState: "pending",
      summaryContainerId: summary.id,
      summaryBlockIds: summaryChildren.map((item) => item.id),
      transcriptPageId: transcript.id,
      transcriptBlockIds: transcriptBlocks.slice(1).map((item) => item.id),
      versionsContainerId: versions.id
    };
    const page: NotebookPageRow = {
      job_id: job.id,
      provider: this.provider,
      parent_page_id: this.parentPageId,
      page_id: pageId,
      page_url: typeof remote.url === "string" ? remote.url : notionPageUrl(pageId),
      current_attempt: row.attempt,
      status_block_id: shell.statusBlockId,
      metadata_table_id: shell.metadataTableId,
      classification_table_id: shell.classificationTableId,
      person_row_id: shell.personRowId,
      appointment_type_row_id: shell.appointmentTypeRowId,
      tags_row_id: shell.tagsRowId,
      review_status_row_id: shell.reviewStatusRowId,
      person_value: null,
      person_provenance: "unset",
      appointment_type_value: null,
      appointment_type_provenance: "unset",
      tags_value: null,
      tags_provenance: "unset",
      review_status_value: "Needs review",
      review_status_provenance: "automatic",
      classification_checked_at: now,
      audio_container_id: shell.audioContainerId,
      audio_block_id: null,
      audio_state: "pending",
      summary_container_id: shell.summaryContainerId,
      summary_block_ids_json: JSON.stringify(shell.summaryBlockIds),
      summary_hash: null,
      transcript_page_id: shell.transcriptPageId,
      transcript_block_ids_json: JSON.stringify(shell.transcriptBlockIds),
      transcript_hash: null,
      versions_container_id: shell.versionsContainerId,
      last_status: null,
      last_title: null,
      created_at: now,
      updated_at: now
    };
    this.db.saveNotebookPage(page);
    return page;
  }

  private async recoverPage(jobId: string): Promise<NotebookPageRow | undefined> {
    const children = await this.notion.children(this.parentPageId);
    for (const child of children) {
      if (child.type !== "child_page") continue;
      const blocks = await this.notion.children(child.id);
      if (!blocks.some((block) => blockText(block) === `Sidecarr Job ID: ${jobId}`)) continue;
      const page = await this.notion.retrievePage(child.id);
      if (page.in_trash === true || page.archived === true) throw new Error("Mapped Notion appointment page is deleted or trashed");
      const shell = await this.recoverShell(child.id, blocks, jobId);
      const now = new Date().toISOString();
      const recovered: NotebookPageRow = {
        job_id: jobId,
        provider: this.provider,
        parent_page_id: this.parentPageId,
        page_id: child.id,
        page_url: typeof page.url === "string" ? page.url : notionPageUrl(child.id),
        current_attempt: shell.currentAttempt,
        status_block_id: shell.statusBlockId,
        metadata_table_id: shell.metadataTableId,
        classification_table_id: shell.classificationTableId,
        person_row_id: shell.personRowId,
        appointment_type_row_id: shell.appointmentTypeRowId,
        tags_row_id: shell.tagsRowId,
        review_status_row_id: shell.reviewStatusRowId,
        person_value: null,
        person_provenance: "unset",
        appointment_type_value: null,
        appointment_type_provenance: "unset",
        tags_value: null,
        tags_provenance: "unset",
        review_status_value: "Needs review",
        review_status_provenance: "automatic",
        classification_checked_at: null,
        audio_container_id: shell.audioContainerId,
        audio_block_id: shell.audioBlockId,
        audio_state: shell.audioState,
        summary_container_id: shell.summaryContainerId,
        summary_block_ids_json: JSON.stringify(shell.summaryBlockIds),
        summary_hash: null,
        transcript_page_id: shell.transcriptPageId,
        transcript_block_ids_json: JSON.stringify(shell.transcriptBlockIds),
        transcript_hash: null,
        versions_container_id: shell.versionsContainerId,
        last_status: null,
        last_title: null,
        created_at: now,
        updated_at: now
      };
      this.db.saveNotebookPage(recovered);
      return recovered;
    }
    return undefined;
  }

  private async recoverShell(pageId: string, blocks: NotionObject[], jobId: string): Promise<PageShell> {
    const byText = (text: string) => blocks.find((block) => blockText(block) === text);
    const tables = blocks.filter((block) => block.type === "table");
    const status = blocks.find((block) => blockText(block).startsWith("Status:"));
    const audio = byText("Audio");
    const summary = byText("Summary");
    const versions = byText("Previous Versions");
    const transcript = blocks.find((block) => block.type === "child_page" && childPageTitle(block) === "Full Transcript");
    if (!status || tables.length < 2 || !audio || !summary || !versions || !transcript) {
      throw new Error(`Notion appointment ${pageId} is missing Sidecarr-owned blocks`);
    }
    const metadataRows = await this.notion.children(tables[0].id);
    const rows = await this.notion.children(tables[1].id);
    const metadata = new Map(metadataRows.map((row) => tableRowValue(row)));
    const parsedAttempt = Number(metadata.get("Current attempt"));
    const audioChildren = await this.notion.children(audio.id);
    const attachedAudio = audioChildren.find((item) => item.type === "audio");
    const skippedAudio = audioChildren.find((item) => /20 MiB|rejected|Open the recording in Scriberr/i.test(blockText(item)));
    const summaryChildren = await this.notion.children(summary.id);
    const transcriptChildren = await this.notion.children(transcript.id);
    if (rows.length < 4 || !transcriptChildren.some((item) => blockText(item).includes(jobId))) {
      throw new Error(`Notion appointment ${pageId} has an invalid Sidecarr marker`);
    }
    return {
      currentAttempt: Number.isInteger(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : 1,
      statusBlockId: status.id,
      metadataTableId: tables[0].id,
      classificationTableId: tables[1].id,
      personRowId: rows[0].id,
      appointmentTypeRowId: rows[1].id,
      tagsRowId: rows[2].id,
      reviewStatusRowId: rows[3].id,
      audioContainerId: audio.id,
      audioBlockId: attachedAudio?.id ?? skippedAudio?.id ?? null,
      audioState: attachedAudio ? "attached" : skippedAudio ? "skipped" : "pending",
      summaryContainerId: summary.id,
      summaryBlockIds: summaryChildren.map((item) => item.id),
      transcriptPageId: transcript.id,
      transcriptBlockIds: transcriptChildren.filter((item) => !blockText(item).startsWith("Sidecarr Transcript for Job ID:")).map((item) => item.id),
      versionsContainerId: versions.id
    };
  }

  private async archiveAttempt(page: NotebookPageRow, row: JobRow): Promise<void> {
    const appointmentBlocks = await this.notion.children(page.page_id);
    const archiveTitlePrefix = `Attempt ${page.current_attempt} —`;
    const versionsBlocks = await this.notion.children(page.versions_container_id);
    const summaryBlocks = await this.notion.children(page.summary_container_id);
    const transcriptPage = await this.notion.retrievePage(page.transcript_page_id);
    const transcriptUrl = typeof transcriptPage.url === "string" ? transcriptPage.url : notionPageUrl(page.transcript_page_id);
    const statusText = blockText(appointmentBlocks.find((block) => block.id === page.status_block_id) ?? { id: "" });
    const archiveChildren: Block[] = [
      paragraph(`Archived at ${new Date().toISOString()}`),
      paragraph(statusText || "Status: previous attempt"),
      paragraph("Archived transcript", transcriptUrl),
      ...summaryBlocks.map(cloneBlock).filter((block): block is Block => Boolean(block))
    ];
    if (!versionsBlocks.some((block) => blockText(block).startsWith(archiveTitlePrefix))) {
      await this.notion.appendChildren(page.versions_container_id, [
        toggle(`Attempt ${page.current_attempt} — ${new Date().toISOString()} (Archived)`, archiveChildren)
      ]);
    }
    await this.notion.updatePageTitle(page.transcript_page_id, `Transcript — Attempt ${page.current_attempt} (Archived)`);

    const refreshedBlocks = await this.notion.children(page.page_id);
    let transcript = refreshedBlocks.find((block) => block.type === "child_page" && childPageTitle(block) === "Full Transcript");
    let transcriptIds: string[];
    if (transcript) {
      const children = await this.notion.children(transcript.id);
      transcriptIds = children.filter((item) => !blockText(item).startsWith("Sidecarr Transcript for Job ID:")).map((item) => item.id);
    } else {
      transcript = await this.notion.createPage(page.page_id, "Full Transcript");
      const transcriptBlocks = await this.notion.appendChildren(transcript.id, [
        paragraph(`Sidecarr Transcript for Job ID: ${row.job_id}`),
        paragraph("Transcription loading…")
      ]);
      transcriptIds = transcriptBlocks.slice(1).map((item) => item.id);
    }
    const currentSummary = await this.notion.children(page.summary_container_id);
    const summaryIds = currentSummary.length === 1 && blockText(currentSummary[0]) === "Waiting for transcription…"
      ? [currentSummary[0].id]
      : await this.replaceOwnedChildren(
        page.summary_container_id,
        jsonIds(page.summary_block_ids_json),
        [paragraph("Waiting for transcription…")]
      );
    this.db.updateNotebookPage(row.job_id, this.provider, {
      current_attempt: row.attempt,
      transcript_page_id: transcript.id,
      transcript_block_ids_json: JSON.stringify(transcriptIds),
      transcript_hash: null,
      summary_block_ids_json: JSON.stringify(summaryIds),
      summary_hash: null,
      last_status: null
    });
  }

  private async syncAudio(job: ScriberrJob, row: JobRow, page: NotebookPageRow): Promise<NotebookOutcome | undefined> {
    if (job.is_multi_track && !job.merged_audio_path) return undefined;
    const operationKey = `audio:${row.attempt}:${job.status}`;
    return this.runOperation(row, operationKey, "attach_audio", async () => {
      const existing = await this.notion.children(page.audio_container_id);
      const attached = existing.find((block) => block.type === "audio");
      if (attached) {
        this.db.updateNotebookPage(job.id, this.provider, { audio_block_id: attached.id, audio_state: "attached" });
        return this.outcome("notebook_audio_attached", "attach_audio", "audio:attached", this.db.getNotebookPage(job.id, this.provider));
      }
      const skipped = existing.find((block) => /20 MiB|rejected|Open the recording in Scriberr/i.test(blockText(block)));
      if (skipped) {
        this.db.updateNotebookPage(job.id, this.provider, { audio_block_id: skipped.id, audio_state: "skipped" });
        return this.outcome("notebook_audio_skipped", "attach_audio", "audio:skipped", this.db.getNotebookPage(job.id, this.provider));
      }
      let response: Response;
      try {
        response = await this.scriberr.getAudio(job.id);
      } catch (error) {
        if (error instanceof ScriberrApiError && error.status === 404) return undefined;
        throw error;
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxSimpleUploadBytes) {
        return this.skipAudio(job, page, `Audio is ${formatMiB(length)}; Notion simple uploads are limited to 20 MiB.`);
      }
      const bytes = await boundedBytes(response, maxSimpleUploadBytes);
      if (!bytes) return this.skipAudio(job, page, "Audio exceeds Notion's 20 MiB simple-upload limit.");
      const contentType = response.headers.get("content-type")?.split(";")[0] || "audio/mpeg";
      const filename = audioFilename(job, response, contentType);
      try {
        const upload = await this.notion.createFileUpload(filename, contentType);
        await this.notion.sendFileUpload(upload.id, bytes, filename, contentType);
        const old = await this.notion.children(page.audio_container_id);
        for (const block of old) await this.notion.trashBlock(block.id);
        const attached = await this.notion.appendChildren(page.audio_container_id, [{
          object: "block",
          type: "audio",
          audio: { type: "file_upload", file_upload: { id: upload.id } }
        }]);
        this.db.updateNotebookPage(job.id, this.provider, {
          audio_block_id: attached[0]?.id ?? null,
          audio_state: "attached"
        });
        const updated = this.db.getNotebookPage(job.id, this.provider)!;
        return this.outcome("notebook_audio_attached", "attach_audio", `audio:attached`, updated);
      } catch (error) {
        if (isPermanentAudioRejection(error)) {
          return this.skipAudio(job, page, "Notion rejected this recording's size or media format.");
        }
        throw error;
      }
    });
  }

  private async skipAudio(job: ScriberrJob, page: NotebookPageRow, reason: string): Promise<NotebookOutcome> {
    const old = await this.notion.children(page.audio_container_id);
    for (const block of old) await this.notion.trashBlock(block.id);
    const appended = await this.notion.appendChildren(page.audio_container_id, [
      paragraph(reason),
      paragraph("Open the recording in Scriberr", this.scriberrPageUrl(job.id))
    ]);
    this.db.updateNotebookPage(job.id, this.provider, {
      audio_block_id: appended[0]?.id ?? null,
      audio_state: "skipped"
    });
    const updated = this.db.getNotebookPage(job.id, this.provider)!;
    return this.outcome("notebook_audio_skipped", "attach_audio", `audio:skipped`, updated);
  }

  private async captureClassificationEdits(page: NotebookPageRow): Promise<void> {
    const checked = page.classification_checked_at ? Date.parse(page.classification_checked_at) : 0;
    if (Date.now() - checked < classificationRefreshMs) return;
    const rows = await this.notion.children(page.classification_table_id);
    const values = new Map(rows.map((row) => tableRowValue(row)));
    const fields = [
      ["Person", "person_value", "person_provenance"],
      ["Appointment Type", "appointment_type_value", "appointment_type_provenance"],
      ["Tags", "tags_value", "tags_provenance"],
      ["Review Status", "review_status_value", "review_status_provenance"]
    ] as const;
    const updates: Partial<NotebookPageRow> = { classification_checked_at: new Date().toISOString() };
    for (const [label, valueKey, provenanceKey] of fields) {
      const remote = normalizeClassification(values.get(label));
      const local = page[valueKey];
      if (remote !== local) {
        updates[valueKey] = remote;
        updates[provenanceKey] = "user";
      }
    }
    this.db.updateNotebookPage(page.job_id, this.provider, updates);
  }

  private async summaryContent(job: ScriberrJob): Promise<string> {
    const inline = job.summary?.trim() ?? "";
    if (job.status !== "completed") return inline;
    try {
      const summary = await this.scriberr.getSummary(job.id);
      return summary.content?.trim() || inline;
    } catch (error) {
      this.logger.debug({ jobId: job.id, error: sanitizeError(error) }, "notebook summary lookup deferred");
      return inline;
    }
  }

  private async replaceOwnedChildren(containerId: string, oldIds: string[], blocks: Block[]): Promise<string[]> {
    for (const id of oldIds) await this.notion.trashBlock(id);
    const appended = await this.notion.appendChildren(containerId, blocks.length > 0 ? blocks : [paragraph("—")]);
    return appended.map((item) => item.id);
  }

  private async runOperation(
    row: JobRow,
    operationKey: string,
    operation: string,
    work: () => Promise<NotebookOutcome | undefined>,
    emitFailure = true,
    completeOnUndefined = false
  ): Promise<NotebookOutcome | undefined> {
    let record = this.db.beginNotebookOperation(row.job_id, this.provider, operationKey, operation);
    if (record.status === "completed" || record.status === "failed") return undefined;
    while (record.attempts < 3) {
      try {
        const outcome = await work();
        if (!outcome) {
          if (completeOnUndefined) this.db.completeNotebookOperation(record.id);
          return undefined;
        }
        this.db.completeNotebookOperation(record.id);
        this.logger.info({ jobId: row.job_id, provider: this.provider, operation, attempt: row.attempt }, "notebook operation completed");
        return outcome;
      } catch (error) {
        const attempts = record.attempts + 1;
        const exhausted = attempts >= 3;
        const message = sanitizeError(error);
        this.db.recordNotebookOperationFailure(record.id, message, exhausted);
        this.logger.warn({ jobId: row.job_id, provider: this.provider, operation, requestAttempt: attempts, exhausted, error: message }, "notebook operation failed");
        if (exhausted) {
          if (!emitFailure) return {
            event: "notebook_sync_failed",
            operation,
            occurrenceKey: `failed:${operationKey}`,
            error: message
          };
          const page = this.db.getNotebookPage(row.job_id, this.provider);
          return this.outcome("notebook_sync_failed", operation, `failed:${operationKey}`, page, message);
        }
        const retryMs = error instanceof NotionApiError && error.retryAfterSeconds
          ? error.retryAfterSeconds * 1000
          : 250 * 2 ** record.attempts;
        if (retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
        record = this.db.getNotebookOperation(row.job_id, this.provider, operationKey)!;
      }
    }
    return undefined;
  }

  private outcome(
    event: NotebookOutcome["event"],
    operation: string,
    occurrenceKey: string,
    page?: NotebookPageRow,
    error?: string
  ): NotebookOutcome {
    return {
      event,
      operation,
      occurrenceKey,
      pageId: page?.page_id,
      pageUrl: page?.page_url,
      ...(error ? { error } : {})
    };
  }

  private title(job: ScriberrJob, row: JobRow): string {
    const title = job.title?.trim();
    if (title) return title;
    const timestamp = job.created_at ?? row.first_seen_at;
    return `Scriberr recording — ${new Date(timestamp).toLocaleDateString("en-US")}`;
  }

  private statusText(job: ScriberrJob, row: JobRow): string {
    const error = row.last_error ? ` — ${sanitizeError(row.last_error)}` : "";
    return `Status: ${row.sidecar_state} (Scriberr: ${job.status}, attempt ${row.attempt})${error}`;
  }

  private scriberrPageUrl(jobId: string): string {
    return `${this.config.scriberrUrl}/audio/${encodeURIComponent(jobId)}`;
  }
}

function paragraph(content: string, link?: string): Block {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [richText(content, link)] } };
}

function paragraphBody(content: string): Block {
  return { paragraph: { rich_text: [richText(content)] } };
}

function heading(content: string): Block {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [richText(content)] } };
}

function callout(content: string, emoji: string): Block {
  return { object: "block", type: "callout", callout: { rich_text: [richText(content)], icon: { type: "emoji", emoji } } };
}

function toggle(content: string, children: Block[] = []): Block {
  return {
    object: "block",
    type: "toggle",
    toggle: { rich_text: [richText(content)], color: "default", ...(children.length ? { children } : {}) }
  };
}

function table(rows: string[][]): Block {
  return {
    object: "block",
    type: "table",
    table: {
      table_width: 2,
      has_column_header: false,
      has_row_header: true,
      children: rows.map((row) => ({
        object: "block",
        type: "table_row",
        table_row: { cells: row.map((cell) => [richText(cell)]) }
      }))
    }
  };
}

function tableRowBody(row: string[]): Block {
  return { table_row: { cells: row.map((cell) => [richText(cell)]) } };
}

function textBlocks(content: string): Block[] {
  const chunks: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line) {
      chunks.push("");
      continue;
    }
    for (let offset = 0; offset < line.length; offset += 2000) chunks.push(line.slice(offset, offset + 2000));
  }
  return chunks.map((chunk) => paragraph(chunk));
}

function markdownBlocks(content: string): Block[] {
  return content.split(/\r?\n/).flatMap((line): Block[] => {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const type = `heading_${headingMatch[1].length}`;
      return [{ object: "block", type, [type]: { rich_text: [richText(headingMatch[2])] } }];
    }
    const checkbox = line.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checkbox) return [{ object: "block", type: "to_do", to_do: { rich_text: [richText(checkbox[2])], checked: checkbox[1].toLowerCase() === "x" } }];
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return [{ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [richText(bullet[1])] } }];
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) return [{ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: [richText(numbered[1])] } }];
    return textBlocks(line);
  });
}

function cloneBlock(block: NotionObject): Block | undefined {
  const type = typeof block.type === "string" ? block.type : "";
  if (!type || !["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "callout"].includes(type)) return undefined;
  const text = blockText(block);
  if (type === "callout") return callout(text, "📦");
  if (type === "to_do") {
    const source = block.to_do;
    const checked = Boolean(source && typeof source === "object" && (source as { checked?: unknown }).checked);
    return { object: "block", type, to_do: { rich_text: [richText(text)], checked } };
  }
  return { object: "block", type, [type]: { rich_text: [richText(text)] } };
}

function tableRowValue(block: NotionObject): [string, string | undefined] {
  const value = block.table_row;
  if (!value || typeof value !== "object") return ["", undefined];
  const cells = (value as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return ["", undefined];
  const text = cells.map((cell) => Array.isArray(cell) ? cell.map(richItemText).join("") : "");
  return [text[0] ?? "", text[1]];
}

function richItemText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const value = item as { plain_text?: unknown; text?: { content?: unknown } };
  if (typeof value.plain_text === "string") return value.plain_text;
  return typeof value.text?.content === "string" ? value.text.content : "";
}

function normalizeClassification(value: string | undefined): string | null {
  const normalized = value?.trim();
  return !normalized || normalized === "—" ? null : normalized;
}

function childPageTitle(block: NotionObject): string {
  const child = block.child_page;
  return child && typeof child === "object" && typeof (child as { title?: unknown }).title === "string"
    ? (child as { title: string }).title
    : "";
}

function required(value: NotionObject | undefined, label: string): NotionObject {
  if (!value) throw new Error(`Notion did not return ${label}`);
  return value;
}

function jsonIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function notionPageUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array | undefined> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function audioFilename(job: ScriberrJob, response: Response, contentType: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const fromHeader = disposition.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i)?.[1];
  const source = fromHeader ? safelyDecodeFilename(fromHeader.replace(/"$/, "")) : job.merged_audio_path || job.audio_path;
  const basename = source ? path.basename(source) : "";
  if (basename && /^[\w.() -]+$/.test(basename)) return basename;
  const extension = contentType.includes("wav") ? "wav" : contentType.includes("mp4") ? "m4a" : "mp3";
  return `${job.id}.${extension}`;
}

function safelyDecodeFilename(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function isPermanentAudioRejection(error: unknown): boolean {
  if (!(error instanceof NotionApiError) || error.status !== 400) return false;
  return /size|large|limit|media|audio|file/i.test(error.message);
}
