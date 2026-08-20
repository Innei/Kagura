import fs from 'node:fs';

import { Command } from 'commander';

import { resolveKaguraPaths } from '../config/paths.js';

export function buildStopCommand(): Command {
  const cmd = new Command('stop');
  cmd.description('Stop the running Kagura process').action(() => {
    process.exitCode = stopKagura();
  });
  return cmd;
}

export function stopKagura(): number {
  const paths = resolveKaguraPaths();
  const rawPid = fs.existsSync(paths.pidFile) ? fs.readFileSync(paths.pidFile, 'utf8').trim() : '';
  const pid = Number.parseInt(rawPid, 10);

  if (!rawPid || Number.isNaN(pid) || pid <= 0) {
    cleanupPidFile(paths.pidFile);
    process.stdout.write('No running Kagura process found.\n');
    return 1;
  }

  if (pid === process.pid) {
    process.stderr.write('Refusing to stop the current kagura stop process.\n');
    return 1;
  }

  try {
    process.kill(pid, 0);
  } catch {
    cleanupPidFile(paths.pidFile);
    process.stdout.write(`No running Kagura process found for PID ${pid}.\n`);
    return 1;
  }

  try {
    process.kill(pid, 'SIGTERM');
    process.stdout.write(`Stopping Kagura process ${pid}.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `Failed to stop Kagura process ${pid}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return 1;
  }
}

function cleanupPidFile(pidFile: string): void {
  fs.rmSync(pidFile, { force: true });
}
