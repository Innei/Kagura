import { Command } from 'commander';

import { buildConfigCommand } from './commands/config.js';
import { buildDoctorCommand } from './commands/doctor.js';
import { buildInitCommand, type InitOptions, runInit } from './commands/init.js';
import { buildManifestCommand } from './commands/manifest.js';
import { buildStopCommand } from './commands/stop.js';
import { detectConfig } from './config/env-loader.js';
import { resolveKaguraPaths } from './config/paths.js';
import { formatVersion } from './version.js';

export interface RunHooks {
  startApp?: () => Promise<void>;
}

export function buildProgram(hooks: RunHooks = {}): Command {
  const program = new Command('kagura');
  program
    .description('Slack-native Claude Agent — CLI')
    .version(formatVersion(), '-V, --version', 'output the version')
    .option('--debug', 'enable debug logging')
    .helpOption('-h, --help', 'display help')
    .showHelpAfterError('(use `kagura --help` for help)');

  program.addCommand(buildConfigCommand());
  program.addCommand(buildDoctorCommand());
  program.addCommand(buildManifestCommand());
  program.addCommand(buildStopCommand());
  program.addCommand(buildInitCommand(hooks));

  program.action(async () => {
    const paths = resolveKaguraPaths();
    const status = detectConfig(paths);
    if (!status.ok) {
      process.stdout.write(`Missing: ${status.missing.join(', ')}. Launching init wizard.\n`);
      const initOpts: InitOptions = {};
      await runInit(initOpts, hooks);
      return;
    }
    if (hooks.startApp) {
      await hooks.startApp();
    } else {
      program.outputHelp();
    }
  });

  return program;
}
