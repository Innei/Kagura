import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/index.js';

describe('kagura stop', () => {
  const origEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kagura-stop-test-'));
    process.env = { ...origEnv, KAGURA_HOME: tempDir };
  });

  afterEach(() => {
    process.env = { ...origEnv };
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports when no running process is recorded', async () => {
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const code = await runCli(['node', 'kagura', 'stop']);
      expect(code).toBe(1);
      expect(out.join('')).toContain('No running Kagura process found.');
    } finally {
      process.stdout.write = write;
    }
  });
});
