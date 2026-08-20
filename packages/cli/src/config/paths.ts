import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KaguraPaths {
  configDir: string;
  configJsonFile: string;
  dataDir: string;
  dbPath: string;
  envFile: string;
  logDir: string;
  pidFile: string;
  tokenStore: string;
}

export interface ResolveOptions {
  cwd?: string;
}

export function resolveKaguraPaths(opts: ResolveOptions = {}): KaguraPaths {
  const cwd = opts.cwd ?? process.cwd();
  const override = process.env.KAGURA_HOME?.trim();
  if (override) {
    return buildPaths(path.resolve(override));
  }

  if (isDevCwd(cwd)) {
    return buildPaths(cwd);
  }

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    return buildPaths(path.join(path.resolve(xdg), 'kagura'));
  }

  const home = process.env.HOME?.trim() || os.homedir();
  return buildPaths(path.join(home, '.config', 'kagura'));
}

function isDevCwd(cwd: string): boolean {
  if (fs.existsSync(path.join(cwd, '.env'))) return true;
  if (fs.existsSync(path.join(cwd, 'apps', 'kagura'))) return true;
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string };
      if (pkg.name === '@innei/kagura' || pkg.name === 'kagura' || pkg.name === 'kagura-monorepo') {
        return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

function buildPaths(configDir: string): KaguraPaths {
  return {
    configDir,
    envFile: path.join(configDir, '.env'),
    configJsonFile: path.join(configDir, 'config.json'),
    dataDir: path.join(configDir, 'data'),
    dbPath: path.join(configDir, 'data', 'sessions.db'),
    logDir: path.join(configDir, 'logs'),
    pidFile: path.join(configDir, 'data', 'kagura.pid'),
    tokenStore: path.join(configDir, 'data', 'slack-config-tokens.json'),
  };
}
