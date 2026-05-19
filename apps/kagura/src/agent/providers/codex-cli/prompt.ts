import fs from 'node:fs';
import os from 'node:os';
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
import { resolveConfiguredSessionDbPath } from '~/env/server.js';

const TMP_DIR = '/tmp/kagura';
const CACHE_IMAGE_DIR = path.resolve(TMP_DIR, 'cache/images');
const CODEX_GENERATED_ARTIFACTS_DIRNAME = 'generated';
const CODEX_RUNTIME_DIRNAME = 'runtime';
const CODEX_RUNTIME_ROOT_DIR = path.join(os.tmpdir(), 'kagura', 'codex-cli');

export interface CodexRuntimePaths {
  channelOpsPath: string;
  generatedArtifactsDir: string;
  memoryDbPath: string;
  runtimeDir: string;
}

const CODEX_PROMPT_PROCESSORS = [
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

export function buildCodexPrompt(
  request: AgentExecutionRequest,
  runtimePaths = getCodexRuntimePaths(request),
): string {
  const prompt = assemblePrompt(request, CODEX_PROMPT_PROCESSORS);
  const imageInputSection = buildCodexImageInputSection(prompt.images);
  const sections: Array<string | undefined> = [
    `<system_instructions>\n${prompt.systemPrompt}\n</system_instructions>`,
    `<codex_runtime_tools>\nThis Codex CLI adapter exposes Kagura host capabilities through files managed outside the current workspace.\n\nMemory operations:\n- Kagura's session database is available at ${runtimePaths.memoryDbPath}; set KAGURA_DB_PATH to this value when running kagura-memory.\n- To save memory, run shell: KAGURA_DB_PATH=${shellQuote(runtimePaths.memoryDbPath)} kagura-memory save --category <preference|context|decision|observation|task_completed> --content "<text>" --scope <global|workspace> [--repo-id <id>] [--expires-at <ISO>].\n- To recall memory, run shell: KAGURA_DB_PATH=${shellQuote(runtimePaths.memoryDbPath)} kagura-memory recall --category <name> --scope <global|workspace> [--repo-id <id>] [--query <substr>] [--limit <n>]. Output is JSON array of records.\n- Save durable preferences, decisions, project facts, implementation outcomes, task-completed notes, or explicit user memory requests. Skip routine status or transcript restatements.\n- The reconciler will dedupe periodically; no need to check existing records before saving.\n\nChannel workspace operations:\n- To call set_channel_default_workspace, append one JSON object per line to ${runtimePaths.channelOpsPath}.\n- JSON shape: {"tool":"set_channel_default_workspace","workspaceInput":"repo name, repo id, alias, or absolute path"}.\n- Use this when the user explicitly says the current Slack channel should use a default repository/workspace for future conversations, including statements like "this channel's workspace is X".\n- Persist an explicit channel workspace declaration even if the same workspace is already present in <session_context>; session context applies to this turn, while the channel default is needed for future threads.\n</codex_runtime_tools>`,
    `<codex_slack_uploads>\nThe direct upload_slack_file tool is not available in this Codex CLI adapter. When you need to send a generated image or file back to Slack, write the final artifact under ${runtimePaths.generatedArtifactsDir}/. The host adapter uploads new or modified files from that directory to the Slack thread after your run. Use normal file extensions such as .png, .jpg, .webp, .gif, .txt, .md, .json, or .csv so the host can classify them.\n</codex_slack_uploads>`,
    buildCodexSkillInstructions(request),
    imageInputSection,
    prompt.userText,
  ];

  if (prompt.images.length > 0 && !imageInputSection) {
    sections.push(
      '<image_notice>\nThis Codex CLI adapter currently does not forward Slack image bytes. If image inspection is necessary, explain that limitation briefly and ask the user for text details or a file path available in the workspace.\n</image_notice>',
    );
  }

  return sections
    .filter(
      (section): section is string => typeof section === 'string' && section.trim().length > 0,
    )
    .join('\n\n');
}

function buildCodexImageInputSection(
  images: ReturnType<typeof assemblePrompt>['images'],
): string | undefined {
  if (images.length === 0) {
    return undefined;
  }

  const entries: string[] = [];
  const failures: string[] = [];

  fs.mkdirSync(CACHE_IMAGE_DIR, { recursive: true });

  for (const [index, image] of images.entries()) {
    const ext = extensionForImageMimeType(image.mimeType, image.fileName);
    const filename = [
      String(index + 1).padStart(2, '0'),
      sanitizeRuntimePathPart(image.messageTs),
      sanitizeRuntimePathPart(image.fileId),
    ].join('-');
    const imagePath = path.join(CACHE_IMAGE_DIR, `${filename}${ext}`);

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
    '<codex_slack_image_inputs>',
    'Slack thread images have been saved as local files for this Codex run.',
    'When the user asks about image contents, inspect the referenced local image path before answering.',
    ...entries,
  ];

  if (failures.length > 0) {
    lines.push('Failed to persist some Slack images:', ...failures);
  }

  lines.push('</codex_slack_image_inputs>');
  return lines.join('\n');
}

export function getCodexRuntimePaths(
  request: AgentExecutionRequest,
  memoryDbPath = resolveConfiguredSessionDbPath(),
): CodexRuntimePaths {
  const rootSuffix = sanitizeRuntimePathPart(
    [request.channelId, request.threadTs, request.executionId ?? 'memory'].join('-'),
  );
  const runtimeRoot = path.join(CODEX_RUNTIME_ROOT_DIR, rootSuffix);
  const runtimeDir = path.join(runtimeRoot, CODEX_RUNTIME_DIRNAME);
  const generatedArtifactsDir = path.join(runtimeRoot, CODEX_GENERATED_ARTIFACTS_DIRNAME);
  const channelOpsPath = path.join(runtimeDir, getCodexChannelOpsFileName(request));

  return {
    channelOpsPath,
    generatedArtifactsDir,
    memoryDbPath,
    runtimeDir,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function getCodexChannelOpsFileName(request: AgentExecutionRequest): string {
  const suffix = sanitizeRuntimePathPart(request.executionId ?? 'channel');
  return `${suffix}-channel-ops.jsonl`;
}

function buildCodexSkillInstructions(request: AgentExecutionRequest): string | undefined {
  const names = extractRequestedSkillNames(request.mentionText);
  if (names.length === 0) {
    return undefined;
  }

  const root = request.workspacePath ?? process.cwd();
  const sections: string[] = [];
  for (const name of names.slice(0, 3)) {
    const skillPath = path.join(root, '.claude', 'skills', name, 'SKILL.md');
    let content: string;
    try {
      content = fs.readFileSync(skillPath, 'utf8');
    } catch {
      continue;
    }

    sections.push(`## /${name}\n${content.trim()}`);
  }

  if (sections.length === 0) {
    return undefined;
  }

  return `<codex_workspace_skills>\nWhen the user asks to invoke one of these slash skills, follow the matching SKILL.md exactly as task instructions.\n\n${sections.join('\n\n')}\n</codex_workspace_skills>`;
}

function extractRequestedSkillNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/\/([\da-z][\w-]{1,80})\b/gi)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return [...names];
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
