import './load-e2e-env.js';

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { filterScenarios, formatScenarioList, parseArgs, resolveByIds } from './cli-utils.js';
import { resolveLiveProviderOverride } from './live-application.js';
import type { LiveE2EScenario } from './scenario.js';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export async function discoverScenarios(): Promise<LiveE2EScenario[]> {
  const liveDir = path.dirname(fileURLToPath(import.meta.url));
  const entries = fs.readdirSync(liveDir).sort();

  const scenarios: LiveE2EScenario[] = [];
  for (const entry of entries) {
    if (!entry.startsWith('run') || !entry.endsWith('.ts')) continue;
    if (entry === 'run.ts' || /^run-[\w-]+\.ts$/.test(entry)) {
      const modulePath = path.join(liveDir, entry);
      const mod = (await import(modulePath)) as { scenario?: LiveE2EScenario };
      if (mod.scenario && typeof mod.scenario.run === 'function') {
        scenarios.push(mod.scenario);
      }
    }
  }

  return scenarios;
}

// ---------------------------------------------------------------------------
// Interactive selection
// ---------------------------------------------------------------------------

async function promptInteractive(scenarios: LiveE2EScenario[]): Promise<LiveE2EScenario[]> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  try {
    console.info('\nAvailable live E2E scenarios:\n');
    console.info(formatScenarioList(scenarios));
    console.info(
      '\nEnter scenario numbers (comma-separated), "all" to run all, or a search term to filter:',
    );

    const answer = (await ask('> ')).trim();

    if (!answer || answer.toLowerCase() === 'all') {
      return scenarios;
    }

    if (/^[\d\s,]+$/.test(answer)) {
      const indices = answer
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10) - 1)
        .filter((n) => n >= 0 && n < scenarios.length);

      if (indices.length === 0) {
        throw new Error('No valid scenario numbers selected.');
      }

      return indices.map((i) => scenarios[i]!);
    }

    const filtered = filterScenarios(scenarios, answer);
    if (filtered.length === 0) {
      throw new Error(`No scenarios matching "${answer}".`);
    }
    return filtered;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RunResult {
  durationMs: number;
  error?: string;
  id: string;
  passed: boolean;
  title: string;
}

async function runScenarios(scenarios: LiveE2EScenario[]): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const scenario of scenarios) {
    console.info(`\n${'─'.repeat(60)}`);
    console.info(`Running: [${scenario.id}] ${scenario.title}`);
    console.info(`${'─'.repeat(60)}\n`);

    const start = Date.now();
    try {
      await scenario.run();
      results.push({
        id: scenario.id,
        title: scenario.title,
        passed: true,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        id: scenario.id,
        title: scenario.title,
        passed: false,
        error: message,
        durationMs: Date.now() - start,
      });
    }
  }
  return results;
}

function printSummary(results: RunResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.info(`\n${'═'.repeat(60)}`);
  console.info('Live E2E Summary');
  console.info(`${'═'.repeat(60)}`);

  for (const r of results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    console.info(`  ${status}  ${r.id.padEnd(32)} ${dur}`);
    if (r.error) {
      console.info(`        ${r.error}`);
    }
  }

  console.info(`${'─'.repeat(60)}`);
  console.info(
    `  Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Time: ${(totalMs / 1000).toFixed(1)}s`,
  );
  console.info(`${'═'.repeat(60)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const userArgs = process.argv.slice(2);
  const args = parseArgs(userArgs);

  const allScenarios = await discoverScenarios();

  if (allScenarios.length === 0) {
    console.error('No live E2E scenarios discovered.');
    process.exitCode = 1;
    return;
  }

  if (args.list) {
    const display = args.search ? filterScenarios(allScenarios, args.search) : allScenarios;
    console.info(`\nDiscovered ${display.length} live E2E scenario(s):\n`);
    console.info(formatScenarioList(display));
    console.info('');
    return;
  }

  let selected: LiveE2EScenario[];

  if (args.scenarioIds.length > 0) {
    selected = resolveByIds(allScenarios, args.scenarioIds);
  } else if (args.interactive) {
    const pool = args.search ? filterScenarios(allScenarios, args.search) : allScenarios;
    selected = await promptInteractive(pool);
  } else if (args.search) {
    selected = filterScenarios(allScenarios, args.search);
    if (selected.length === 0) {
      console.error(`No scenarios matching "${args.search}".`);
      process.exitCode = 1;
      return;
    }
    console.info(`Running ${selected.length} scenario(s) matching "${args.search}":\n`);
  } else {
    selected = allScenarios;
    console.info(`Running all ${selected.length} live E2E scenario(s).\n`);
  }

  const providerFilter = resolveLiveProviderOverride();
  if (providerFilter) {
    const skipped = selected.filter((scenario) => !isProviderCompatible(scenario, providerFilter));
    selected = selected.filter((scenario) => isProviderCompatible(scenario, providerFilter));
    if (skipped.length > 0) {
      console.info(
        `Skipping ${skipped.length} provider-specific scenario(s) incompatible with ${providerFilter}: ${skipped
          .map((scenario) => scenario.id)
          .join(', ')}`,
      );
    }
    if (selected.length === 0) {
      console.error(`No scenarios are compatible with SLACK_E2E_PROVIDER_ID=${providerFilter}.`);
      process.exitCode = 1;
      return;
    }
  }

  const results = await runScenarios(selected);
  printSummary(results);

  const anyFailed = results.some((r) => !r.passed);
  if (anyFailed) {
    process.exitCode = 1;
  }
}

await main();

function isProviderCompatible(scenario: LiveE2EScenario, providerId: string): boolean {
  if (!scenario.provider || scenario.provider.kind === 'generic') {
    return true;
  }
  return scenario.provider.providerId === providerId;
}
