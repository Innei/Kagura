import type { ContextMemories } from '~/memory/types.js';
import type { SessionReasoningEffort } from '~/session/types.js';
import type { NormalizedThreadContext } from '~/slack/context/thread-context-loader.js';

export interface GeneratedOutputFile {
  fileName: string;
  path: string;
  providerFileId: string;
}

export type GeneratedImageFile = GeneratedOutputFile;

export interface AgentA2AParticipant {
  id: string;
  isCurrentAgent: boolean;
  isLead: boolean;
  label?: string | undefined;
  role?: string | undefined;
}

export interface AgentA2AContext {
  leadId: string;
  participants: AgentA2AParticipant[];
  teamId?: string | undefined;
}

export interface AgentExecutionRequest {
  a2aContext?: AgentA2AContext | undefined;
  abortSignal?: AbortSignal;
  botUserId?: string;
  botUserName?: string;
  channelId: string;
  contextMemories?: ContextMemories;
  currentTriggerTs?: string;
  executionId?: string;
  mentionText: string;
  modelOverride?: string;
  previousTurnTriggerTs?: string;
  reasoningEffortOverride?: SessionReasoningEffort;
  resumeHandle?: string;
  threadContext: NormalizedThreadContext;
  threadTs: string;
  userId: string;
  workspaceBranch?: string;
  workspaceLabel?: string;
  workspacePath?: string;
  workspaceRepoId?: string;
}

export interface ModelUsageInfo {
  cacheCreationInputTokens: number;
  cacheHitRate: number;
  cacheReadInputTokens: number;
  costUSD: number;
  inputTokens: number;
  inputTokensIncludeCache?: boolean | undefined;
  model: string;
  outputTokens: number;
}

export interface SessionUsageInfo {
  costKnown?: boolean | undefined;
  durationMs: number;
  modelUsage: ModelUsageInfo[];
  totalCostUSD: number;
}

export interface AgentUserInputOption {
  description: string;
  label: string;
  preview?: string | undefined;
}

export interface AgentUserInputQuestion {
  header: string;
  multiSelect?: boolean | undefined;
  options: AgentUserInputOption[];
  question: string;
}

export interface AgentUserInputRequest {
  annotations?: Record<
    string,
    {
      notes?: string | undefined;
      preview?: string | undefined;
    }
  >;
  answers?: Record<string, string>;
  metadata?: {
    source?: string | undefined;
  };
  questions: AgentUserInputQuestion[];
}

export interface AgentUserInputResponse {
  annotations?: Record<
    string,
    {
      notes?: string | undefined;
      preview?: string | undefined;
    }
  >;
  answers: Record<string, string>;
}
export type AgentExecutionEvent =
  | {
      type: 'lifecycle';
      phase: 'started';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'completed';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'stopped';
      reason: 'superseded' | 'user_stop';
      resumeHandle?: string;
    }
  | {
      type: 'lifecycle';
      phase: 'failed';
      resumeHandle?: string;
      error: string;
    }
  | {
      type: 'assistant-message';
      text: string;
    }
  | {
      type: 'assistant-message-delta';
      text: string;
    }
  | {
      type: 'workspace-context';
      workspaceLabel?: string | undefined;
      workspacePath: string;
      workspaceRepoId?: string | undefined;
    }
  | {
      type: 'activity-state';
      state: AgentActivityState;
    }
  | {
      type: 'task-update';
      taskId: string;
      title: string;
      status: 'pending' | 'in_progress' | 'complete' | 'error';
      details?: string;
      output?: string;
    }
  | {
      type: 'generated-images';
      files: GeneratedImageFile[];
    }
  | {
      type: 'generated-files';
      files: GeneratedOutputFile[];
    }
  | {
      type: 'usage-info';
      usage: SessionUsageInfo;
    };

export interface AgentActivityState {
  activities?: string[] | undefined;
  clear?: boolean | undefined;
  composing?: boolean | undefined;
  status?: string | undefined;
  threadTs: string;
}

export interface AgentPermissionRequest {
  description?: string | undefined;
  input: Record<string, unknown>;
  toolName: string;
}

export interface AgentPermissionResponse {
  allowed: boolean;
}

export interface AgentExecutionSink {
  onEvent: (event: AgentExecutionEvent) => Promise<void>;
  requestPermission?: (
    request: AgentPermissionRequest,
    options?: {
      signal?: AbortSignal | undefined;
    },
  ) => Promise<AgentPermissionResponse>;
  requestUserInput?: (
    request: AgentUserInputRequest,
    options?: {
      description?: string | undefined;
      displayName?: string | undefined;
      signal?: AbortSignal | undefined;
      title?: string | undefined;
      toolUseId?: string | undefined;
    },
  ) => Promise<AgentUserInputResponse>;
}

export interface AgentExecutor {
  drain: () => Promise<void>;
  execute: (request: AgentExecutionRequest, sink: AgentExecutionSink) => Promise<void>;
  readonly providerId: string;
}
