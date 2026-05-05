import { describe, expect, it } from 'vitest';

import {
  buildManifest,
  DESIRED_BOT_EVENTS,
  DESIRED_COMMANDS,
  DESIRED_SHORTCUTS,
} from '../src/slack/manifest-template.js';

describe('manifest-template', () => {
  it('produces expected manifest structure', () => {
    const m = buildManifest({ appName: 'Kagura', botDisplayName: 'kagura' });
    expect(m).toMatchSnapshot();
  });

  it('exports desired command / shortcut / event sets', () => {
    expect(DESIRED_COMMANDS.map((c) => c.command).sort()).toEqual(
      ['/usage', '/workspace', '/memory', '/session', '/version', '/provider', '/model'].sort(),
    );
    expect(DESIRED_SHORTCUTS.map((s) => s.callback_id)).toContain('stop_reply_action');
    expect([...DESIRED_BOT_EVENTS].sort()).toEqual(
      ['app_home_opened', 'message.channels', 'message.groups', 'message.im'].sort(),
    );
  });
});
