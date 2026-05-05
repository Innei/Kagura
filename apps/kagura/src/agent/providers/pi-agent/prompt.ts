import fs from 'node:fs';
import path from 'node:path';

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
  const imageInputSection = buildPiAgentImageInputSection(prompt.images, runtimePaths);
  const sections: Array<string | undefined> = [
    `<system_instructions>\n${prompt.systemPrompt}\n</system_instructions>`,
    `<pi_agent_runtime_tools>\nThis Pi Agent adapter exposes Kagura host capabilities through files managed outside the current workspace.\n\nMemory operations:\n- Kagura's session database is available at ${runtimePaths.memoryDbPath}; set KAGURA_DB_PATH to this value when running kagura-memory.\n- To save memory, run shell: KAGURA_DB_PATH=${shellQuote(runtimePaths.memoryDbPath)} kagura-memory save --category <preference|context|decision|observation|task_completed> --content "<text>" --scope <global|workspace> [--repo-id <id>] [--expires-at <ISO>].\n- To recall memory, run shell: KAGURA_DB_PATH=${shellQuote(runtimePaths.memoryDbPath)} kagura-memory recall --category <name> --scope <global|workspace> [--repo-id <id>] [--query <substr>] [--limit <n>]. Output is JSON array of records.\n\nChannel workspace operations:\n- To call set_channel_default_workspace, append one JSON object per line to ${runtimePaths.channelOpsPath}.\n- JSON shape: {"tool":"set_channel_default_workspace","workspaceInput":"repo name, repo id, alias, or absolute path"}.\n- Use this only when the user explicitly says the current Slack channel should use a default repository/workspace for future conversations.\n</pi_agent_runtime_tools>`,
    `<pi_agent_slack_uploads>\nWhen you need to send a generated image or file back to Slack, write the final artifact under ${runtimePaths.generatedArtifactsDir}/. The host adapter uploads new or modified files from that directory to the Slack thread after your run. Use normal file extensions such as .png, .jpg, .webp, .gif, .txt, .md, .json, or .csv so the host can classify them.\n</pi_agent_slack_uploads>`,
    imageInputSection,
    prompt.userText,
  ];

  return sections
    .filter(
      (section): section is string => typeof section === 'string' && section.trim().length > 0,
    )
    .join('\n\n');
}

function buildPiAgentImageInputSection(
  images: ReturnType<typeof assemblePrompt>['images'],
  runtimePaths: PiAgentRuntimePaths,
): string | undefined {
  if (images.length === 0) {
    return undefined;
  }

  const imageDir = path.join(runtimePaths.runtimeDir, 'images');
  const entries: string[] = [];
  const failures: string[] = [];

  fs.mkdirSync(imageDir, { recursive: true });

  for (const [index, image] of images.entries()) {
    const ext = extensionForImageMimeType(image.mimeType, image.fileName);
    const filename = [
      String(index + 1).padStart(2, '0'),
      sanitizeRuntimePathPart(image.messageTs),
      sanitizeRuntimePathPart(image.fileId),
    ].join('-');
    const imagePath = path.join(imageDir, `${filename}${ext}`);

    try {
      fs.writeFileSync(imagePath, Buffer.from(image.base64Data, 'base64'));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`- ${image.fileName}: ${detail}`);
      continue;
    }

    entries.push(
      [
        `Image ${index + 1}`,
        `ts=${image.messageTs}`,
        `filename=${image.fileName}`,
        `mime=${image.mimeType || 'unknown'}`,
        `thread_message_index=${image.messageIndex}`,
        `path=${imagePath}`,
      ].join(' | '),
    );
  }

  if (entries.length === 0 && failures.length === 0) {
    return undefined;
  }

  const lines = [
    '<pi_agent_slack_image_inputs>',
    'Slack thread images have been saved as local files for this Pi Agent run.',
    'When the user asks about image contents, inspect the referenced local image path before answering.',
    ...entries,
  ];

  if (failures.length > 0) {
    lines.push('Failed to persist some Slack images:', ...failures);
  }

  lines.push('</pi_agent_slack_image_inputs>');
  return lines.join('\n');
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

function extensionForImageMimeType(mimeType: string, fileName: string): string {
  const fileExt = path.extname(fileName).toLowerCase();
  if (fileExt && ['.gif', '.jpeg', '.jpg', '.png', '.webp'].includes(fileExt)) {
    return fileExt;
  }

  const base = mimeType.split(';')[0]?.trim().toLowerCase();
  switch (base) {
    case 'image/gif': {
      return '.gif';
    }
    case 'image/jpeg':
    case 'image/jpg': {
      return '.jpg';
    }
    case 'image/webp': {
      return '.webp';
    }
    case 'image/png':
    default: {
      return '.png';
    }
  }
}
