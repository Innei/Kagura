interface SlackApiSuccessResponse {
  ok: true;
  response_metadata?: {
    warnings?: string[];
  };
}

interface SlackApiErrorResponse {
  error: string;
  ok: false;
}

type SlackApiResponse<T> = SlackApiSuccessResponse & T;

export interface SlackAuthTestResponse {
  team: string;
  team_id: string;
  url: string;
  user: string;
  user_id: string;
}

export interface SlackPostedMessageResponse {
  channel: string;
  message?: {
    text?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
  };
  ts: string;
}

/** File metadata returned on messages (e.g. shared uploads, image attachments). */
export interface SlackMessageFile {
  filetype?: string;
  id?: string;
  mimetype?: string;
  name?: string;
  pretty_type?: string;
  title?: string;
  url_private?: string;
}

export interface SlackConversationRepliesResponse {
  has_more?: boolean;
  messages?: Array<{
    blocks?: Array<{
      block_id?: string;
      elements?: Array<Record<string, unknown>>;
      slack_file?: { id?: string };
      type?: string;
    }>;
    bot_id?: string;
    files?: SlackMessageFile[];
    text?: string;
    thread_ts?: string;
    ts?: string;
    user?: string;
  }>;
}

export interface SlackGetUploadUrlExternalResponse {
  file_id: string;
  upload_url: string;
}

export interface SlackCompleteUploadExternalResponse {
  files?: Array<{
    id?: string;
    title?: string;
  }>;
}

export interface SlackReactionsGetResponse {
  channel: string;
  message?: {
    reactions?: Array<{
      count: number;
      name: string;
      users: string[];
    }>;
    text?: string;
    ts?: string;
  };
  type: string;
}

export class SlackApiClient {
  constructor(private readonly token: string) {}

  async authTest(): Promise<SlackAuthTestResponse> {
    return this.call<SlackAuthTestResponse>('auth.test', undefined, 'GET');
  }

  async postMessage(args: {
    blocks?: unknown[];
    channel: string;
    text: string;
    thread_ts?: string;
    unfurl_links?: boolean;
    unfurl_media?: boolean;
  }): Promise<SlackPostedMessageResponse> {
    return this.call<SlackPostedMessageResponse>('chat.postMessage', args, 'POST');
  }

  async updateMessage(args: {
    blocks?: unknown[];
    channel: string;
    text: string;
    ts: string;
  }): Promise<Record<string, never>> {
    return this.call<Record<string, never>>('chat.update', args, 'POST');
  }

  async addReaction(args: {
    channel: string;
    name: string;
    timestamp: string;
  }): Promise<Record<string, never>> {
    return this.call<Record<string, never>>('reactions.add', args, 'POST');
  }

  async getReactions(args: {
    channel: string;
    timestamp: string;
  }): Promise<SlackReactionsGetResponse> {
    return this.call<SlackReactionsGetResponse>('reactions.get', { ...args, full: true }, 'GET');
  }

  async conversationReplies(args: {
    channel: string;
    inclusive?: boolean;
    limit?: number;
    ts: string;
  }): Promise<SlackConversationRepliesResponse> {
    return this.call<SlackConversationRepliesResponse>('conversations.replies', args, 'GET');
  }

  /**
   * Upload a file into a channel thread using Slack's external upload flow
   * (`files.getUploadURLExternal` → POST bytes → `files.completeUploadExternal`).
   * Intended for the E2E trigger user token so the bot sees a real thread attachment.
   */
  async uploadFileToThread(args: {
    alt_text?: string;
    channel_id: string;
    data: Uint8Array;
    filename: string;
    initial_comment?: string;
    thread_ts: string;
    title?: string;
  }): Promise<SlackCompleteUploadExternalResponse> {
    const { channel_id, data, filename, thread_ts } = args;
    const title = args.title ?? filename;

    const uploadTicket = await this.call<SlackGetUploadUrlExternalResponse>(
      'files.getUploadURLExternal',
      {
        alt_txt: args.alt_text,
        filename,
        length: data.byteLength,
      },
      'POST',
    );

    await this.postBytesToSlackUploadStorage(uploadTicket.upload_url, data);

    const filesJson = JSON.stringify([{ id: uploadTicket.file_id, title }]);

    return this.call<SlackCompleteUploadExternalResponse>(
      'files.completeUploadExternal',
      {
        channel_id,
        files: filesJson,
        initial_comment: args.initial_comment,
        thread_ts,
      },
      'POST',
    );
  }

  async downloadPrivateFile(url: string): Promise<{ contentType: string; data: Uint8Array }> {
    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Slack private file download failed with HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    return {
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
      data: new Uint8Array(buffer),
    };
  }

  async downloadPrivateTextFile(url: string): Promise<{ contentType: string; text: string }> {
    const { contentType, data } = await this.downloadPrivateFile(url);
    return {
      contentType,
      text: new TextDecoder('utf-8').decode(data),
    };
  }

  private async call<T extends object>(
    method: string,
    params?: Record<string, unknown>,
    httpMethod: 'GET' | 'POST' = 'POST',
  ): Promise<SlackApiResponse<T>> {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value === undefined) {
        continue;
      }

      searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }

    const url =
      httpMethod === 'GET' && searchParams.size > 0
        ? `https://slack.com/api/${method}?${searchParams.toString()}`
        : `https://slack.com/api/${method}`;

    const response = await this.fetchWithRetry(url, {
      method: httpMethod,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(httpMethod === 'POST'
          ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }
          : {}),
      },
      ...(httpMethod === 'POST' ? { body: searchParams.toString() } : {}),
    });

    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as SlackApiResponse<T> | SlackApiErrorResponse;
    if (!data.ok) {
      throw new Error(`Slack API ${method} error: ${data.error}`);
    }

    return data;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await fetch(url, init);
      } catch (error) {
        lastError = error;
        if (attempt === 3) {
          break;
        }

        await delay(500 * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async postBytesToSlackUploadStorage(uploadUrl: string, data: Uint8Array): Promise<void> {
    const response = await this.fetchWithRetry(uploadUrl, {
      body: Buffer.from(data),
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      method: 'POST',
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Slack file storage upload failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
