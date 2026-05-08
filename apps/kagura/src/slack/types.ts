export interface SlackReactionsApi {
  add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
  remove: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
}

export interface SlackAssistantThreadsApi {
  setStatus: (args: {
    channel_id: string;
    thread_ts: string;
    status: string;
    loading_messages?: string[];
  }) => Promise<unknown>;
}

export interface SlackAssistantApi {
  threads: SlackAssistantThreadsApi;
}

export interface SlackAuthApi {
  test: () => Promise<{
    bot_id?: string;
    name?: string;
    team?: string;
    team_id?: string;
    user?: string;
    user_id?: string;
  }>;
}

export interface SlackConversationsApi {
  replies: (args: {
    channel: string;
    ts: string;
    inclusive?: boolean;
    limit?: number;
  }) => Promise<{ messages?: unknown[] }>;
}

export interface SlackMrkdwnTextObject {
  text: string;
  type: 'mrkdwn';
}

export interface SlackPlainTextObject {
  emoji?: boolean;
  text: string;
  type: 'plain_text';
}

export type SlackTextObject = SlackMrkdwnTextObject | SlackPlainTextObject;

export interface SlackSectionBlock {
  text: SlackTextObject;
  type: 'section';
}

export interface SlackContextBlock {
  elements: SlackMrkdwnTextObject[];
  type: 'context';
}

export interface SlackButtonElement {
  action_id: string;
  style?: 'danger' | 'primary';
  text: SlackPlainTextObject;
  type: 'button';
  url?: string;
  value?: string;
}

export interface SlackActionsBlock {
  block_id?: string;
  elements: SlackButtonElement[];
  type: 'actions';
}

export interface SlackImageBlock {
  alt_text?: string;
  slack_file: { id: string };
  type: 'image';
}

export interface SlackRichTextBlock {
  block_id?: string;
  elements: Array<{
    elements: Array<{ text: string; type: 'text' }>;
    type: 'rich_text_section';
  }>;
  type: 'rich_text';
}

export interface SlackTaskCardBlock {
  details?: SlackRichTextBlock;
  output?: SlackRichTextBlock;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  task_id: string;
  title: string;
}

export interface SlackPlanBlock {
  block_id?: string;
  tasks?: SlackTaskCardBlock[];
  title: string;
  type: 'plan';
}

export type SlackBlock =
  | SlackActionsBlock
  | SlackContextBlock
  | SlackImageBlock
  | SlackPlanBlock
  | SlackRichTextBlock
  | SlackSectionBlock;

export interface SlackFilesUploadV2Response {
  file?: { id?: string };
  files?: Array<{ id?: string; files?: Array<{ id?: string }> }>;
}

export interface SlackFilesApi {
  uploadV2: (args: {
    alt_text?: string;
    channel_id: string;
    file: Buffer;
    filename: string;
    thread_ts: string;
    title?: string;
  }) => Promise<SlackFilesUploadV2Response>;
}

export interface SlackChatApi {
  delete: (args: { channel: string; ts: string }) => Promise<unknown>;
  postEphemeral?: (args: {
    channel: string;
    text: string;
    thread_ts?: string;
    user: string;
  }) => Promise<unknown>;
  postMessage: (args: {
    blocks?: unknown[];
    channel: string;
    text: string;
    thread_ts?: string;
  }) => Promise<{ ts?: string }>;
  update: (args: {
    blocks?: SlackBlock[];
    channel: string;
    text: string;
    ts: string;
  }) => Promise<unknown>;
}

export interface SlackViewsApi {
  open: (args: { trigger_id: string; view: unknown }) => Promise<unknown>;
  publish: (args: { user_id: string; view: unknown }) => Promise<unknown>;
}

export interface SlackWebClientLike {
  assistant: SlackAssistantApi;
  auth?: SlackAuthApi;
  chat: SlackChatApi;
  conversations: SlackConversationsApi;
  files: SlackFilesApi;
  reactions: SlackReactionsApi;
  views: SlackViewsApi;
}
