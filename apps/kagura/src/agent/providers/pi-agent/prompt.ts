import {
  assemblePrompt,
  codingWorkflowProcessor,
  collaborationRulesProcessor,
  fileContextProcessor,
  hostCapabilityProcessor,
  hostContractProcessor,
  identityProcessor,
  imageCollectionProcessor,
  memoryContextProcessor,
  memoryPolicyProcessor,
  sessionContextProcessor,
  threadContextProcessor,
  trustBoundaryProcessor,
  userMessageProcessor,
} from '~/agent/prompt/index.js';
import type { AgentExecutionRequest } from '~/agent/types.js';
import { env } from '~/env/server.js';

const PI_AGENT_PROMPT_PROCESSORS = [
  identityProcessor,
  hostContractProcessor,
  trustBoundaryProcessor,
  collaborationRulesProcessor,
  hostCapabilityProcessor,
  codingWorkflowProcessor,
  memoryPolicyProcessor,
  sessionContextProcessor,
  memoryContextProcessor,
  threadContextProcessor,
  fileContextProcessor,
  userMessageProcessor,
  imageCollectionProcessor,
];

export interface PiAgentRuntimePaths {
  channelOpsPath: string;
  generatedArtifactsDir: string;
  memoryDbPath: string;
  runtimeDir: string;
}

export function buildPiAgentPrompt(
  request: AgentExecutionRequest,
  runtimePaths: PiAgentRuntimePaths,
): string {
  const prompt = assemblePrompt(request, PI_AGENT_PROMPT_PROCESSORS);
  const sections: Array<string | undefined> = [
    `<system_instructions>\n${prompt.systemPrompt}\n</system_instructions>`,
    `<pi_agent_runtime_tools>\nThis Pi Agent adapter exposes Kagura host capabilities through files managed outside the current workspace.\n\nMemory operations:\n- Kagura's session database is available at ${runtimePaths.memoryDbPath}; set KAGURA_DB_PATH to this value when running kagura-memory.\n- To save memory, run shell: KAGURA_DB_PATH=${shellQuote(runtimePaths.memoryDbPath)} kagura-memory save --category <preference|context|decision|observation|task_completed> --content "<text>" --scope <global|workspace> [--repo-id <id>] [--expires-at <ISO>].\n- To recall memory, run shell: KAGURA_DB_PATH=${shellQuote(runtimePaths.memoryDbPath)} kagura-memory recall --category <name> --scope <global|workspace> [--repo-id <id>] [--query <substr>] [--limit <n>]. Output is JSON array of records.\n\nChannel workspace operations:\n- To call set_channel_default_workspace, append one JSON object per line to ${runtimePaths.channelOpsPath}.\n- JSON shape: {"tool":"set_channel_default_workspace","workspaceInput":"repo name, repo id, alias, or absolute path"}.\n- Use this only when the user explicitly says the current Slack channel should use a default repository/workspace for future conversations.\n</pi_agent_runtime_tools>`,
    `<pi_agent_slack_uploads>\nWhen you need to send a generated image or file back to Slack, write the final artifact under ${runtimePaths.generatedArtifactsDir}/. The host adapter uploads new or modified files from that directory to the Slack thread after your run. Use normal file extensions such as .png, .jpg, .webp, .gif, .txt, .md, .json, or .csv so the host can classify them.\n</pi_agent_slack_uploads>`,
    prompt.images.length > 0
      ? '<image_notice>\nThis Pi Agent MVP adapter does not forward Slack image bytes directly. If image inspection is necessary, explain that limitation briefly and ask the user for text details or a file path available in the workspace.\n</image_notice>'
      : undefined,
    prompt.userText,
  ];

  return sections
    .filter(
      (section): section is string => typeof section === 'string' && section.trim().length > 0,
    )
    .join('\n\n');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function getPiAgentRuntimePaths(request: AgentExecutionRequest): PiAgentRuntimePaths {
  const rootSuffix = sanitizeRuntimePathPart(
    [request.channelId, request.threadTs, request.executionId ?? 'memory'].join('-'),
  );
  const runtimeDir = `/tmp/kagura/pi-agent/${rootSuffix}/runtime`;
  const generatedArtifactsDir = `/tmp/kagura/pi-agent/${rootSuffix}/generated`;
  return {
    channelOpsPath: `${runtimeDir}/${sanitizeRuntimePathPart(
      request.executionId ?? 'channel',
    )}-channel-ops.jsonl`,
    generatedArtifactsDir,
    memoryDbPath: env.SESSION_DB_PATH,
    runtimeDir,
  };
}

function sanitizeRuntimePathPart(value: string): string {
  return value.replaceAll(/[^\w.-]/g, '_').slice(0, 120) || 'memory';
}
