import './load-e2e-env.js';

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createApplication } from '~/application.js';
import { env } from '~/env/server.js';

import type { LiveE2EScenario } from './scenario.js';
import { runDirectly } from './scenario.js';
import { SlackApiClient, type SlackConversationRepliesResponse } from './slack-api-client.js';

const START_MARKER_PREFIX = 'BRANCH_PR_CONTEXT_START';
const DONE_MARKER_PREFIX = 'BRANCH_PR_CONTEXT_DONE';

interface FixtureRepo {
  defaultBranch: string;
  headBranch: string;
  path: string;
  prNumber: number;
  prUrl: string;
  repo: string;
}

interface WorkspaceBranchPrContextReply {
  contextTexts: string[];
  text: string;
  ts: string;
}

interface WorkspaceBranchPrContextResult {
  botUserId: string;
  channelId: string;
  failureMessage?: string;
  firstReply?: WorkspaceBranchPrContextReply;
  fixtureDefaultBranch?: string;
  fixturePath?: string;
  fixturePrBranch?: string;
  fixturePrNumber?: number;
  fixturePrUrl?: string;
  fixtureRepo?: string;
  matched: {
    firstReplyInitialBranchSeen: boolean;
    firstReplyObserved: boolean;
    firstReplyUpdatedBranchSeen: boolean;
    secondReplyUpdatedPrSeen: boolean;
    secondReplyObserved: boolean;
  };
  passed: boolean;
  rootMessageTs?: string;
  runId: string;
  secondReply?: WorkspaceBranchPrContextReply;
}

async function main(): Promise<void> {
  if (!env.SLACK_E2E_ENABLED) {
    throw new Error(
      'Set SLACK_E2E_ENABLED=true before running the workspace-branch-pr-context E2E.',
    );
  }

  if (!env.SLACK_E2E_CHANNEL_ID || !env.SLACK_E2E_TRIGGER_USER_TOKEN) {
    throw new Error(
      'Live workspace-branch-pr-context E2E requires SLACK_E2E_CHANNEL_ID and SLACK_E2E_TRIGGER_USER_TOKEN.',
    );
  }

  const runId = randomUUID();
  const triggerClient = new SlackApiClient(env.SLACK_E2E_TRIGGER_USER_TOKEN);
  const botClient = new SlackApiClient(env.SLACK_BOT_TOKEN);
  const botIdentity = await botClient.authTest();
  const fixture = prepareFixtureRepo(runId);

  const result: WorkspaceBranchPrContextResult = {
    botUserId: botIdentity.user_id,
    channelId: env.SLACK_E2E_CHANNEL_ID,
    fixtureDefaultBranch: fixture.defaultBranch,
    fixturePath: fixture.path,
    fixturePrBranch: fixture.headBranch,
    fixturePrNumber: fixture.prNumber,
    fixturePrUrl: fixture.prUrl,
    fixtureRepo: fixture.repo,
    matched: {
      firstReplyInitialBranchSeen: false,
      firstReplyObserved: false,
      firstReplyUpdatedBranchSeen: false,
      secondReplyUpdatedPrSeen: false,
      secondReplyObserved: false,
    },
    passed: false,
    runId,
  };

  const application = createApplication({ defaultProviderId: 'codex-cli' });
  let caughtError: unknown;

  try {
    await application.start();
    await delay(3_000);

    const prompt = [
      `<@${botIdentity.user_id}> [e2e:${runId}] Use workspace path ${fixture.path} for this task.`,
      `This workspace starts on branch ${fixture.defaultBranch}.`,
      `First send one assistant message with exactly "${START_MARKER_PREFIX} ${runId}".`,
      'After sending that marker, pause for about 5 seconds by running a shell sleep command.',
      `Then check out branch ${fixture.headBranch}.`,
      `Finally send one assistant message with exactly "${DONE_MARKER_PREFIX} ${runId}".`,
      'Do not ask questions and do not send any other assistant messages.',
    ].join(' ');

    const rootMessage = await triggerClient.postMessage({
      channel: env.SLACK_E2E_CHANNEL_ID,
      text: prompt,
      unfurl_links: false,
      unfurl_media: false,
    });
    result.rootMessageTs = rootMessage.ts;
    console.info('Posted root message: %s', rootMessage.ts);

    const deadline = Date.now() + env.SLACK_E2E_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const replies = await botClient.conversationReplies({
        channel: env.SLACK_E2E_CHANNEL_ID,
        inclusive: true,
        limit: 100,
        ts: rootMessage.ts,
      });

      const firstReply = findReplyByMarker(
        replies,
        rootMessage.ts,
        botIdentity.user_id,
        `${START_MARKER_PREFIX} ${runId}`,
      );
      if (firstReply) {
        result.firstReply = firstReply;
        result.matched.firstReplyObserved = true;
        result.matched.firstReplyInitialBranchSeen =
          result.matched.firstReplyInitialBranchSeen ||
          firstReply.contextTexts.some((text) => text.includes(`branch: ${fixture.defaultBranch}`));
      }

      const secondReply = findReplyByMarker(
        replies,
        rootMessage.ts,
        botIdentity.user_id,
        `${DONE_MARKER_PREFIX} ${runId}`,
      );
      if (secondReply) {
        result.secondReply = secondReply;
        result.matched.secondReplyObserved = true;
        result.matched.secondReplyUpdatedPrSeen =
          result.matched.secondReplyUpdatedPrSeen ||
          secondReply.contextTexts.some((text) => text.includes(`#${fixture.prNumber}`));
      }

      if (result.firstReply?.ts) {
        const refreshedFirstReply = findReplyByTs(replies, result.firstReply.ts);
        if (refreshedFirstReply) {
          result.firstReply = refreshedFirstReply;
          result.matched.firstReplyUpdatedBranchSeen =
            result.matched.firstReplyUpdatedBranchSeen ||
            refreshedFirstReply.contextTexts.some((text) =>
              text.includes(`branch: ${fixture.headBranch}`),
            );
        }
      }

      if (
        result.matched.firstReplyObserved &&
        result.matched.firstReplyInitialBranchSeen &&
        result.matched.firstReplyUpdatedBranchSeen &&
        result.matched.secondReplyUpdatedPrSeen &&
        result.matched.secondReplyObserved
      ) {
        break;
      }

      await delay(1_500);
    }

    await writeResult(result);
    assertResult(result);
    result.passed = true;
    await writeResult(result);

    console.info('Live workspace-branch-pr-context E2E passed.');
    console.info('Root thread: %s', result.rootMessageTs);
    console.info('First reply: %s', result.firstReply?.ts);
    console.info('Second reply: %s', result.secondReply?.ts);
  } catch (error) {
    result.failureMessage = error instanceof Error ? error.message : String(error);
    caughtError = error;
  } finally {
    await writeResult(result).catch((error) => {
      console.error('Failed to persist workspace-branch-pr-context result:', error);
    });
    await Promise.race([application.stop(), delay(10_000)]).catch((error) => {
      console.error('Failed to stop application:', error);
    });
    await fs.rm(fixture.path, { recursive: true, force: true }).catch((error) => {
      console.error('Failed to clean up fixture repo:', error);
    });
  }

  if (caughtError) {
    if (isDirectExecution()) {
      process.exit(1);
    }
    throw caughtError;
  }

  if (isDirectExecution()) {
    process.exit(0);
  }
}

function prepareFixtureRepo(runId: string): FixtureRepo {
  const source = findFixtureSourceRepo();
  const fixturePath = path.resolve(env.REPO_ROOT_DIR, `kagura-live-pr-fixture-${runId}`);
  execFileSync('rm', ['-rf', fixturePath], { stdio: 'ignore' });
  execFileSync(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      source.defaultBranch,
      `https://github.com/${source.repo}.git`,
      fixturePath,
    ],
    { stdio: 'ignore' },
  );
  execFileSync(
    'git',
    ['-C', fixturePath, 'fetch', 'origin', `${source.headBranch}:${source.headBranch}`],
    { stdio: 'ignore' },
  );
  execFileSync('git', ['-C', fixturePath, 'checkout', source.defaultBranch], { stdio: 'ignore' });

  return {
    defaultBranch: source.defaultBranch,
    headBranch: source.headBranch,
    path: fixturePath,
    prNumber: source.prNumber,
    prUrl: source.prUrl,
    repo: source.repo,
  };
}

function findFixtureSourceRepo(): Omit<FixtureRepo, 'path'> {
  const candidates = uniqueStrings([
    detectCurrentRepoSlug(process.cwd()),
    'cli/cli',
    'charmbracelet/glow',
  ]);

  for (const repo of candidates) {
    if (!repo) {
      continue;
    }

    let repoInfo: { defaultBranchRef?: { name?: string } };
    try {
      repoInfo = runJsonCommand<{ defaultBranchRef?: { name?: string } }>('gh', [
        'repo',
        'view',
        repo,
        '--json',
        'defaultBranchRef',
      ]);
    } catch {
      continue;
    }
    const defaultBranch = repoInfo.defaultBranchRef?.name;
    if (!defaultBranch) {
      continue;
    }

    let prs: Array<{
      headRefName?: string;
      isCrossRepository?: boolean;
      number?: number;
      url?: string;
    }>;
    try {
      prs = runJsonCommand<
        Array<{
          headRefName?: string;
          isCrossRepository?: boolean;
          number?: number;
          url?: string;
        }>
      >('gh', [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--json',
        'headRefName,isCrossRepository,number,url',
        '--limit',
        '20',
      ]);
    } catch {
      continue;
    }
    const match = prs.find(
      (pr) =>
        pr.isCrossRepository === false &&
        typeof pr.headRefName === 'string' &&
        pr.headRefName.length > 0 &&
        pr.headRefName !== defaultBranch &&
        typeof pr.number === 'number' &&
        typeof pr.url === 'string' &&
        pr.url.length > 0,
    );

    if (!match?.headRefName || typeof match.number !== 'number' || !match.url) {
      continue;
    }

    return {
      defaultBranch,
      headBranch: match.headRefName,
      prNumber: match.number,
      prUrl: match.url,
      repo,
    };
  }

  throw new Error(
    'Could not find a GitHub repository with a same-repo open PR for the live fixture.',
  );
}

function detectCurrentRepoSlug(workspacePath: string): string | undefined {
  try {
    const remote = execFileSync('git', ['-C', workspacePath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    return parseGithubRepoSlug(remote);
  } catch {
    return undefined;
  }
}

function parseGithubRepoSlug(remoteUrl: string): string | undefined {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  return undefined;
}

function runJsonCommand<T>(command: string, args: string[]): T {
  const raw = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(raw) as T;
}

function findReplyByMarker(
  replies: SlackConversationRepliesResponse,
  rootTs: string,
  botUserId: string,
  marker: string,
): WorkspaceBranchPrContextReply | undefined {
  const message = replies.messages?.find((candidate) => {
    if (!candidate.ts || candidate.ts === rootTs) return false;
    if (!(candidate.user === botUserId || candidate.bot_id)) return false;
    return typeof candidate.text === 'string' && candidate.text.includes(marker);
  });

  if (!message?.ts || typeof message.text !== 'string') {
    return undefined;
  }

  return {
    contextTexts: extractContextTexts(message.blocks),
    text: message.text,
    ts: message.ts,
  };
}

function findReplyByTs(
  replies: SlackConversationRepliesResponse,
  targetTs: string,
): WorkspaceBranchPrContextReply | undefined {
  const message = replies.messages?.find((candidate) => candidate.ts === targetTs);
  if (!message?.ts || typeof message.text !== 'string') {
    return undefined;
  }

  return {
    contextTexts: extractContextTexts(message.blocks),
    text: message.text,
    ts: message.ts,
  };
}

function extractContextTexts(
  blocks?: Array<{ elements?: Array<Record<string, unknown>>; type?: string }>,
): string[] {
  if (!blocks) return [];

  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'context') continue;
    for (const element of block.elements ?? []) {
      if (typeof element.text === 'string' && element.text.trim().length > 0) {
        texts.push(element.text);
      }
    }
  }

  return texts;
}

function assertResult(result: WorkspaceBranchPrContextResult): void {
  const failures: string[] = [];

  if (!result.matched.firstReplyObserved) {
    failures.push(`first marker "${START_MARKER_PREFIX} ${result.runId}" was not observed`);
  }
  if (!result.matched.firstReplyInitialBranchSeen) {
    failures.push('first reply did not expose the initial branch before the checkout');
  }
  if (!result.matched.secondReplyObserved) {
    failures.push(`second marker "${DONE_MARKER_PREFIX} ${result.runId}" was not observed`);
  }
  if (!result.matched.firstReplyUpdatedBranchSeen) {
    failures.push('first reply was not updated to the new branch after checkout');
  }
  if (!result.matched.secondReplyUpdatedPrSeen) {
    failures.push('final reply did not include the PR link in the usage context row');
  }

  if (failures.length > 0) {
    throw new Error(`Live workspace-branch-pr-context E2E failed: ${failures.join('; ')}`);
  }
}

async function writeResult(result: WorkspaceBranchPrContextResult): Promise<void> {
  const resultPath = env.SLACK_E2E_RESULT_PATH.replace(
    /result\.json$/,
    'workspace-branch-pr-context-result.json',
  );
  const absolutePath = path.resolve(process.cwd(), resultPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDirectExecution(): boolean {
  return process.argv[1]?.endsWith('run-workspace-branch-pr-context.ts') ?? false;
}

export const scenario: LiveE2EScenario = {
  id: 'workspace-branch-pr-context',
  provider: {
    kind: 'specific',
    providerId: 'codex-cli',
    reason: 'Requires Codex branch and PR workflow behavior.',
  },
  title: 'Workspace Branch And PR Context Refresh',
  description:
    'Verify that the first workspace context block updates when the agent changes branches and adds a PR link when the new branch has an open PR.',
  keywords: ['workspace', 'branch', 'pr', 'context', 'toolbar', 'dynamic'],
  run: main,
};

runDirectly(scenario);
