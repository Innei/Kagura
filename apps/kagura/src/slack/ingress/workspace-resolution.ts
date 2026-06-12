import fs from 'node:fs';

import type { ChannelPreferenceStore } from '~/channel-preference/types.js';
import type { SessionRecord } from '~/session/types.js';
import type { WorkspaceResolver } from '~/workspace/resolver.js';
import { resolveWorkspaceBranch } from '~/workspace/resolver.js';
import type { ResolvedWorkspace, WorkspaceResolution } from '~/workspace/types.js';

import { encodeWorkspacePickerButtonValue } from '../interactions/workspace-picker-payload.js';
import type { SlackBlock } from '../types.js';

export const WORKSPACE_PICKER_ACTION_ID = 'workspace_picker_open_modal';

export function resolveWorkspaceForConversation(
  messageText: string,
  existingSession: SessionRecord | undefined,
  workspaceResolver: WorkspaceResolver,
  channelPreferenceStore: ChannelPreferenceStore,
  channelId: string,
  workspaceOverride?: ResolvedWorkspace,
): WorkspaceResolution {
  if (workspaceOverride) {
    return {
      status: 'unique',
      workspace: workspaceOverride,
    };
  }

  if (
    existingSession?.workspacePath &&
    existingSession.workspaceRepoId &&
    existingSession.workspaceRepoPath &&
    existingSession.workspaceLabel
  ) {
    if (fs.existsSync(existingSession.workspacePath)) {
      const workspaceBranch = resolveWorkspaceBranch(existingSession.workspacePath);
      return {
        status: 'unique',
        workspace: {
          input: existingSession.workspacePath,
          matchKind:
            existingSession.workspacePath === existingSession.workspaceRepoPath ? 'repo' : 'path',
          repo: {
            aliases: [],
            id: existingSession.workspaceRepoId,
            label: existingSession.workspaceRepoId,
            name:
              existingSession.workspaceRepoId.split('/').at(-1) ?? existingSession.workspaceRepoId,
            repoPath: existingSession.workspaceRepoPath,
            relativePath: existingSession.workspaceRepoId,
          },
          source: existingSession.workspaceSource ?? 'manual',
          ...(workspaceBranch ? { workspaceBranch } : {}),
          workspaceLabel: existingSession.workspaceLabel,
          workspacePath: existingSession.workspacePath,
        },
      };
    }

    if (fs.existsSync(existingSession.workspaceRepoPath)) {
      const workspaceBranch = resolveWorkspaceBranch(existingSession.workspaceRepoPath);
      return {
        status: 'unique',
        workspace: {
          input: existingSession.workspaceRepoPath,
          matchKind: 'repo',
          repo: {
            aliases: [],
            id: existingSession.workspaceRepoId,
            label: existingSession.workspaceRepoId,
            name:
              existingSession.workspaceRepoId.split('/').at(-1) ?? existingSession.workspaceRepoId,
            repoPath: existingSession.workspaceRepoPath,
            relativePath: existingSession.workspaceRepoId,
          },
          source: existingSession.workspaceSource ?? 'manual',
          ...(workspaceBranch ? { workspaceBranch } : {}),
          workspaceLabel: existingSession.workspaceRepoId,
          workspacePath: existingSession.workspaceRepoPath,
        },
      };
    }
  }

  const preference = channelPreferenceStore.get(channelId);
  if (preference?.defaultWorkspaceInput) {
    const preferenceResolution = workspaceResolver.resolveManualInput(
      preference.defaultWorkspaceInput,
      'manual',
    );
    if (preferenceResolution.status === 'unique') {
      return preferenceResolution;
    }
  }

  const autoResolution = workspaceResolver.resolveFromText(messageText, 'auto');
  if (autoResolution.status !== 'missing') {
    return autoResolution;
  }

  return autoResolution;
}

export function buildWorkspaceResolutionBlocks(
  resolution: Extract<WorkspaceResolution, { status: 'ambiguous' }>,
  originalMessageText: string,
): { blocks: SlackBlock[]; text: string } {
  const labels = resolution.candidates
    .slice(0, 5)
    .map((candidate) => `\`${candidate.label}\``)
    .join(', ');
  const text = `I couldn't tell which repository to use — matched: ${labels}`;

  return {
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'actions',
        block_id: 'workspace_picker',
        elements: [
          {
            action_id: WORKSPACE_PICKER_ACTION_ID,
            style: 'primary',
            text: { type: 'plain_text' as const, text: 'Choose Workspace' },
            type: 'button' as const,
            value: encodeWorkspacePickerButtonValue(originalMessageText),
          },
        ],
      },
    ],
    text,
  };
}
