import type { MemoryScope } from '~/memory/types.js';

export type {
  AgentActivityState,
  AgentExecutionEvent,
  AgentExecutionRequest,
  AgentExecutionSink,
  AgentExecutor,
} from '~/agent/types.js';

/**
 * @deprecated Use AgentExecutionRequest from '~/agent/types.js'
 */
export type { AgentExecutionRequest as ClaudeExecutionRequest } from '~/agent/types.js';

/**
 * @deprecated Use AgentExecutionEvent from '~/agent/types.js'
 */
export type { AgentExecutionEvent as ClaudeExecutionEvent } from '~/agent/types.js';

/**
 * @deprecated Use AgentExecutionSink from '~/agent/types.js'
 */
export type { AgentExecutionSink as ClaudeExecutionSink } from '~/agent/types.js';

/**
 * @deprecated Use AgentExecutor from '~/agent/types.js'
 */
export type { AgentExecutor as ClaudeExecutor } from '~/agent/types.js';

export type RuntimeSystemStatusKey = 'auth' | 'compacting' | 'hook' | 'permission' | 'retry';

export interface RuntimeToolStatus {
  text: string;
  toolName?: string;
}

export interface RuntimeTaskStatus {
  taskId?: string;
  text: string;
}

export interface ActiveStreamToolUse {
  partialInput: string;
  toolName: string;
  updatedAt: number;
}

export interface RuntimeUiStateTracker {
  activeStreamToolUses: Map<number, ActiveStreamToolUse>;
  loadingMessages: string[];
  sessionStatus: string | undefined;
  systemStatuses: Partial<Record<RuntimeSystemStatusKey, string>>;
  taskStatus: RuntimeTaskStatus | undefined;
  textStreamingActive: boolean;
  toolStatus: RuntimeToolStatus | undefined;
}

export interface MessageHandlers {
  getSessionCwd: () => string | undefined;
  publishUiState: () => Promise<void>;
  runtimeUi: RuntimeUiStateTracker;
  setSessionCwd: (cwd: string) => void;
  setSessionId: (id: string) => void;
  workspaceContext?: {
    workspaceLabel?: string | undefined;
    workspacePath?: string | undefined;
    workspaceRepoId?: string | undefined;
  };
}

export interface ResolvedMemoryScope {
  missingWorkspace: boolean;
  repoId: string | undefined;
  scope: MemoryScope;
}
