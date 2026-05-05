export type LiveE2EProviderId = 'claude-code' | 'codex-cli' | 'pi-agent';

export type LiveE2EProviderRequirement =
  | { kind: 'generic' }
  | { kind: 'specific'; providerId: LiveE2EProviderId; reason?: string | undefined };

export interface LiveE2EScenario {
  description: string;
  id: string;
  keywords: string[];
  provider?: LiveE2EProviderRequirement | undefined;
  run: () => Promise<void>;
  title: string;
}

export function runDirectly(scenario: LiveE2EScenario): void {
  const isDirectRun =
    process.argv[1] &&
    (process.argv[1].endsWith(`/${scenarioFileName(scenario.id)}`) ||
      process.argv[1].endsWith(`/${scenarioFileName(scenario.id).replace('.ts', '.js')}`));

  if (isDirectRun) {
    scenario.run().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}

function scenarioFileName(id: string): string {
  return id === 'full' ? 'run.ts' : `run-${id}.ts`;
}
