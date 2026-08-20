import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveKaguraPaths } from '@kagura/cli/config/paths';

import { createApplication } from './application.js';

export async function startApp(): Promise<void> {
  const paths = resolveKaguraPaths();
  if (shouldStartDaemon()) {
    startDaemon(paths);
    return;
  }

  const application = createApplication();
  let stopping = false;

  await application.start();

  if (!shouldKeepForeground()) {
    return;
  }

  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.writeFileSync(paths.pidFile, `${process.pid}\n`, 'utf8');

  await new Promise<void>((resolve) => {
    const cleanup = () => {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
      fs.rmSync(paths.pidFile, { force: true });
    };

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
      if (stopping) return;
      stopping = true;
      cleanup();

      application.logger.warn('Received %s. Beginning graceful shutdown.', signal);
      await application.stop();
      resolve();
    };

    const handleSigint = () => void shutdown('SIGINT');
    const handleSigterm = () => void shutdown('SIGTERM');

    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
  });
}

function shouldStartDaemon(): boolean {
  return process.env.KAGURA_DEBUG !== 'true' && process.env.KAGURA_DAEMON_CHILD !== 'true';
}

function shouldKeepForeground(): boolean {
  return process.env.KAGURA_DEBUG === 'true' || process.env.KAGURA_DAEMON_CHILD === 'true';
}

function startDaemon(paths: ReturnType<typeof resolveKaguraPaths>): void {
  fs.mkdirSync(paths.dataDir, { recursive: true });

  const existingPid = readPid(paths.pidFile);
  if (existingPid && isProcessRunning(existingPid)) {
    process.stdout.write(`ℹ Slack Socket Mode application already running. pid=${existingPid}\n`);
    return;
  }
  if (existingPid) {
    fs.rmSync(paths.pidFile, { force: true });
  }

  const entrypoint = process.argv[1];
  if (!entrypoint) {
    throw new Error('Unable to determine Kagura CLI entrypoint for daemon start.');
  }

  const logFile = path.join(paths.dataDir, 'kagura-daemon.log');
  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    detached: true,
    env: {
      ...process.env,
      KAGURA_DAEMON_CHILD: 'true',
    },
    stdio: ['ignore', out, err],
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(paths.pidFile, `${child.pid}\n`, 'utf8');
  process.stdout.write(`ℹ Slack Socket Mode application started. pid=${child.pid}\n`);
  process.stdout.write(`ℹ Logs: ${logFile}\n`);
}

function readPid(pidFile: string): number | undefined {
  const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '';
  const pid = Number.parseInt(raw, 10);
  return raw && !Number.isNaN(pid) && pid > 0 ? pid : undefined;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
