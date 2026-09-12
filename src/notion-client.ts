import { sanitizeError } from "./errors.js";

const notionVersion = "2026-03-11";

export type NotionObject = Record<string, unknown> & { id: string };

type NotionList<T> = {
  results: T[];
  has_more: boolean;
  next_cursor?: string | null;
};

export class NotionApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "NotionApiError";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export function parseNotionPageId(value: string): string {
  const compact = value.replace(/-/g, "");
  const matches = compact.match(/[0-9a-f]{32}/gi);
  const raw = matches?.at(-1);
  if (!raw) throw new Error("Notion parent page URL does not contain a page ID");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`.toLowerCase();
}

export class NotionClient {
  private lastRequestAt = 0;

  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.notion.com/v1",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly minimumRequestIntervalMs = 334,
    private readonly requestTimeoutMs = 30_000
  ) {}

  async retrievePage(pageId: string): Promise<NotionObject> {
    return this.request<NotionObject>(`/pages/${pageId}`);
  }

  async createPage(parentPageId: string, title: string, children: Array<Record<string, unknown>> = []): Promise<NotionObject> {
    return this.request<NotionObject>("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        properties: {
          title: { title: [richText(title)] }
        },
        ...(children.length ? { children } : {})
      })
    });
  }

  async updatePageTitle(pageId: string, title: string): Promise<void> {
    await this.request(`/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { title: { title: [richText(title)] } } })
    });
  }

  async movePage(pageId: string, parentPageId: string): Promise<void> {
    await this.request(`/pages/${pageId}/move`, {
      method: "POST",
      body: JSON.stringify({ parent: { type: "page_id", page_id: parentPageId } })
    });
  }

  async children(blockId: string): Promise<NotionObject[]> {
    const results: NotionObject[] = [];
    let cursor: string | undefined;
    do {
      const query = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : "?page_size=100";
      const page = await this.request<NotionList<NotionObject>>(`/blocks/${blockId}/children${query}`);
      results.push(...page.results);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  async appendChildren(blockId: string, children: Array<Record<string, unknown>>): Promise<NotionObject[]> {
    const results: NotionObject[] = [];
    for (let offset = 0; offset < children.length; offset += 100) {
      const response = await this.request<NotionList<NotionObject>>(`/blocks/${blockId}/children`, {
        method: "PATCH",
        body: JSON.stringify({ children: children.slice(offset, offset + 100) })
      });
      results.push(...response.results);
    }
    return results;
  }

  async updateBlock(blockId: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/blocks/${blockId}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  async trashBlock(blockId: string): Promise<void> {
    await this.request(`/blocks/${blockId}`, {
      method: "PATCH",
      body: JSON.stringify({ in_trash: true })
    });
  }

  async createFileUpload(filename: string, contentType: string): Promise<NotionObject> {
    return this.request<NotionObject>("/file_uploads", {
      method: "POST",
      body: JSON.stringify({ mode: "single_part", filename, content_type: contentType })
    });
  }

  async sendFileUpload(uploadId: string, bytes: Uint8Array, filename: string, contentType: string): Promise<void> {
    const form = new FormData();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append("file", new Blob([copy.buffer], { type: contentType }), filename);
    await this.request(`/file_uploads/${uploadId}/send`, { method: "POST", body: form });
  }

  private async request<T = NotionObject>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("Notion-Version", notionVersion);
    headers.set("Accept", "application/json");
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      const waitMs = this.minimumRequestIntervalMs - (Date.now() - this.lastRequestAt);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastRequestAt = Date.now();
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs)
      });
    } catch (error) {
      throw new NotionApiError(0, `Notion request failed: ${sanitizeError(error)}`);
    }
    if (!response.ok) {
      const raw = await response.text().catch(() => "");
      let code: string | undefined;
      let message = raw;
      try {
        const parsed = JSON.parse(raw) as { code?: string; message?: string };
        code = parsed.code;
        message = parsed.message ?? raw;
      } catch {
        // Keep the bounded response text for diagnostics.
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new NotionApiError(
        response.status,
        `Notion API ${response.status}${message ? `: ${sanitizeError(message, 200)}` : ""}`,
        code,
        Number.isFinite(retryAfter) ? retryAfter : undefined
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}

export function richText(content: string, link?: string): Record<string, unknown> {
  return {
    type: "text",
    text: { content: content.slice(0, 2000), ...(link ? { link: { url: link } } : {}) }
  };
}

export function blockText(block: NotionObject): string {
  const type = typeof block.type === "string" ? block.type : "";
  const value = block[type];
  if (!value || typeof value !== "object") return "";
  const rich = (value as { rich_text?: unknown }).rich_text;
  if (!Array.isArray(rich)) return "";
  return rich.map((item) => {
    if (!item || typeof item !== "object") return "";
    const entry = item as { plain_text?: unknown; text?: { content?: unknown } };
    return typeof entry.plain_text === "string"
      ? entry.plain_text
      : typeof entry.text?.content === "string" ? entry.text.content : "";
  }).join("");
}
