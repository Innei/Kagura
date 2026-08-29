import type { AppLogger } from '~/logger/index.js';

import type { SlackBlock, SlackWebClientLike } from '../types.js';

const DEFAULT_FLUSH_INTERVAL_MS = 300;
const DEFAULT_FLUSH_CHARS = 200;

export interface StreamingReplyOptions {
  flushChars?: number | undefined;
  flushIntervalMs?: number | undefined;
}

export interface StreamingReplyTarget {
  channelId: string;
  recipientTeamId?: string | undefined;
  recipientUserId?: string | undefined;
  threadTs: string;
}

// Slack's streaming API is append-only and rate limited, so deltas are
// coalesced into one append per flush window instead of one per token.
export class StreamingReply {
  private buffer = '';
  private accumulated = '';
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private streamTs: string | undefined;
  private unavailable = false;

  private readonly flushChars: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly client: SlackWebClientLike,
    private readonly logger: AppLogger,
    private readonly target: StreamingReplyTarget,
    options: StreamingReplyOptions = {},
  ) {
    this.flushChars = options.flushChars ?? DEFAULT_FLUSH_CHARS;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  get text(): string {
    return this.accumulated + this.buffer;
  }

  get ts(): string | undefined {
    return this.streamTs;
  }

  // True once the stream has failed and the caller must fall back to a plain
  // thread reply carrying `text`.
  get failed(): boolean {
    return this.unavailable;
  }

  append(text: string): void {
    if (this.unavailable || !text) {
      return;
    }

    this.buffer += text;
    if (this.buffer.length >= this.flushChars) {
      this.scheduleFlush(0);
      return;
    }
    this.scheduleFlush(this.flushIntervalMs);
  }

  async finish(blocks?: SlackBlock[]): Promise<string | undefined> {
    this.clearTimer();
    await this.inFlight;
    if (this.unavailable) {
      return undefined;
    }

    const remainder = this.buffer;
    this.buffer = '';

    if (!this.streamTs) {
      if (!remainder) {
        return undefined;
      }
      const started = await this.start(remainder);
      if (!started) {
        this.buffer = remainder;
        return undefined;
      }
    } else if (remainder) {
      const appended = await this.appendToStream(remainder);
      if (!appended) {
        this.buffer = remainder;
        return undefined;
      }
    }

    const ts = this.streamTs;
    if (!ts) {
      return undefined;
    }

    try {
      await this.client.chat.stopStream?.({
        channel: this.target.channelId,
        ts,
        ...(blocks && blocks.length > 0 ? { blocks } : {}),
      });
    } catch (error) {
      this.logger.warn('Failed to stop Slack stream %s: %s', ts, String(error));
    }
    return ts;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.inFlight = this.inFlight.then(() => this.flush());
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private async flush(): Promise<void> {
    if (this.unavailable || !this.buffer) {
      return;
    }

    const chunk = this.buffer;
    this.buffer = '';

    const ok = this.streamTs ? await this.appendToStream(chunk) : await this.start(chunk);
    if (!ok) {
      // Keep the chunk so `finish` can hand the full text to the fallback path.
      this.buffer = chunk + this.buffer;
    }
  }

  private async start(text: string): Promise<boolean> {
    if (!this.client.chat.startStream) {
      this.unavailable = true;
      return false;
    }

    try {
      const response = await this.client.chat.startStream({
        channel: this.target.channelId,
        thread_ts: this.target.threadTs,
        markdown_text: text,
        ...(this.target.recipientTeamId ? { recipient_team_id: this.target.recipientTeamId } : {}),
        ...(this.target.recipientUserId ? { recipient_user_id: this.target.recipientUserId } : {}),
      });
      if (!response.ts) {
        this.unavailable = true;
        return false;
      }
      this.streamTs = response.ts;
      this.accumulated += text;
      return true;
    } catch (error) {
      this.logger.warn('Failed to start Slack stream: %s', String(error));
      this.unavailable = true;
      return false;
    }
  }

  private async appendToStream(text: string): Promise<boolean> {
    const ts = this.streamTs;
    if (!ts || !this.client.chat.appendStream) {
      return false;
    }

    try {
      await this.client.chat.appendStream({
        channel: this.target.channelId,
        ts,
        markdown_text: text,
      });
      this.accumulated += text;
      return true;
    } catch (error) {
      this.logger.warn('Failed to append to Slack stream %s: %s', ts, String(error));
      return false;
    }
  }
}
