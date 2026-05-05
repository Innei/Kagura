#!/usr/bin/env node

import path from 'node:path';

import * as p from '@clack/prompts';
import { Command } from 'commander';
import pc from 'picocolors';

import { discoverScenarios, filterScenarios, resolveByIds } from './discovery.js';
import { promptInteractive } from './prompt.js';
import { formatSummary, runScenarios } from './runner.js';
import type { LiveE2EProviderId, LiveE2EScenario } from './types.js';

const isTTY = process.stdout.isTTY === true;

function quietSpinner() {
  let current = '';
  return {
    start(msg: string) {
      current = msg;
    },
    stop(msg: string) {
      console.info(msg);
      current = '';
    },
    message(msg: string) {
      current = msg;
    },
  };
}

function resolveLiveDir(): string {
  const rootDir = process.env.LIVE_E2E_DIR;
  if (rootDir) return path.resolve(rootDir);

  return path.resolve(process.cwd(), 'src/e2e/live');
}

async function actionList(opts: { search?: string }): Promise<void> {
  const liveDir = resolveLiveDir();
  const all = await discoverScenarios(liveDir);

  if (all.length === 0) {
    p.log.warn('No live E2E scenarios discovered.');
    return;
  }

  const display = opts.search ? filterScenarios(all, opts.search) : all;

  p.intro(pc.bold(`Discovered ${display.length} live E2E scenario(s)`));

  for (const s of display) {
    p.log.info(
      `${pc.bold(pc.cyan(s.id))} — ${s.title}\n  ${pc.dim(s.description)}\n  ${pc.dim(`keywords: ${s.keywords.join(', ')}`)}`,
    );
  }

  p.outro(`${display.length} scenario(s) found.`);
}

async function actionRun(
  ids: string[],
  opts: { interactive?: boolean; search?: string },
): Promise<void> {
  const liveDir = resolveLiveDir();
  const all = await discoverScenarios(liveDir);

  if (all.length === 0) {
    p.log.error('No live E2E scenarios discovered.');
    process.exitCode = 1;
    return;
  }

  let selected: LiveE2EScenario[];

  if (ids.length > 0) {
    selected = resolveByIds(all, ids);
  } else if (opts.interactive) {
    const pool = opts.search ? filterScenarios(all, opts.search) : all;
    selected = await promptInteractive(pool);
  } else if (opts.search) {
    selected = filterScenarios(all, opts.search);
    if (selected.length === 0) {
      p.log.error(`No scenarios matching "${opts.search}".`);
      process.exitCode = 1;
      return;
    }
  } else {
    selected = all;
  }

  const providerFilter = resolveProviderFilter();
  if (providerFilter) {
    const skipped = selected.filter((scenario) => !isProviderCompatible(scenario, providerFilter));
    selected = selected.filter((scenario) => isProviderCompatible(scenario, providerFilter));
    if (skipped.length > 0) {
      const message = `Skipping ${skipped.length} provider-specific scenario(s) incompatible with ${providerFilter}: ${skipped
        .map((scenario) => scenario.id)
        .join(', ')}`;
      if (isTTY) {
        p.log.info(message);
      } else {
        console.info(message);
      }
    }
    if (selected.length === 0) {
      p.log.error(`No scenarios are compatible with SLACK_E2E_PROVIDER_ID=${providerFilter}.`);
      process.exitCode = 1;
      return;
    }
  }

  if (isTTY) {
    p.intro(
      pc.bold(`Running ${selected.length} scenario(s): ${selected.map((s) => s.id).join(', ')}`),
    );
  }

  const spinner = isTTY ? p.spinner() : quietSpinner();

  const results = await runScenarios(
    selected,
    (scenario) => {
      spinner.start(`Running ${pc.bold(scenario.id)} — ${scenario.title}`);
    },
    (result) => {
      if (result.passed) {
        spinner.stop(
          `${pc.green('PASS')} ${pc.bold(result.id)} ${pc.dim(`(${(result.durationMs / 1000).toFixed(1)}s)`)}`,
        );
      } else {
        spinner.stop(
          `${pc.red('FAIL')} ${pc.bold(result.id)} ${pc.dim(`(${(result.durationMs / 1000).toFixed(1)}s)`)}${result.error ? `\n       ${pc.dim(result.error)}` : ''}`,
        );
      }
    },
  );

  const summary = formatSummary(results);
  console.info(summary);

  const anyFailed = results.some((r) => !r.passed);
  if (isTTY) {
    if (anyFailed) {
      p.outro(pc.red('Some scenarios failed.'));
    } else {
      p.outro(pc.green('All scenarios passed!'));
    }
  }
  if (anyFailed) {
    process.exitCode = 1;
  }
}

function preprocessArgv(): string[] {
  const raw = process.argv.slice(2);
  const idx = raw.indexOf('--');
  if (idx !== -1) {
    return [...raw.slice(0, idx), ...raw.slice(idx + 1)];
  }
  return raw;
}

const program = new Command()
  .name('live-e2e')
  .description('Interactive CLI runner for Slack live E2E scenarios')
  .version('0.1.0');

program
  .command('list')
  .alias('ls')
  .description('List all discovered scenarios')
  .option('-s, --search <term>', 'Filter scenarios by keyword')
  .action(actionList);

program
  .command('run [ids...]', { isDefault: true })
  .description('Run specific scenarios by id, or all if none specified')
  .option('-i, --interactive', 'Interactive scenario picker')
  .option('-l, --list', 'List all scenarios instead of running them')
  .option('-s, --search <term>', 'Filter scenarios by keyword')
  .action(
    async (ids: string[], opts: { interactive?: boolean; list?: boolean; search?: string }) => {
      if (opts.list) {
        await actionList(opts.search ? { search: opts.search } : {});
        return;
      }
      await actionRun(ids, {
        ...(opts.interactive ? { interactive: opts.interactive } : {}),
        ...(opts.search ? { search: opts.search } : {}),
      });
    },
  );

program.parse([process.argv[0]!, process.argv[1]!, ...preprocessArgv()]);

function resolveProviderFilter(): LiveE2EProviderId | undefined {
  const raw = process.env.SLACK_E2E_PROVIDER_ID?.trim();
  if (!raw) return undefined;
  if (raw === 'claude-code' || raw === 'codex-cli' || raw === 'pi-agent') return raw;
  throw new Error(
    `Unsupported SLACK_E2E_PROVIDER_ID "${raw}". Expected one of: claude-code, codex-cli, pi-agent`,
  );
}

function isProviderCompatible(scenario: LiveE2EScenario, providerId: LiveE2EProviderId): boolean {
  if (!scenario.provider || scenario.provider.kind === 'generic') {
    return true;
  }
  return scenario.provider.providerId === providerId;
}
