export interface SlackManifestSlashCommand {
  command: string;
  description: string;
  should_escape?: boolean;
  url?: string;
  usage_hint?: string;
}

export interface SlackManifestShortcut {
  callback_id: string;
  description: string;
  name: string;
  type: 'global' | 'message';
}

export interface SlackManifest {
  display_information: { name: string };
  features: {
    bot_user: { display_name: string; always_online: boolean };
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    slash_commands: SlackManifestSlashCommand[];
    shortcuts: SlackManifestShortcut[];
  };
  oauth_config: { scopes: { bot: string[] } };
  settings: {
    event_subscriptions: { bot_events: string[] };
    interactivity: { is_enabled: boolean };
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

export const DESIRED_COMMANDS: SlackManifestSlashCommand[] = [
  {
    command: '/usage',
    description: 'Show bot usage stats (sessions, memories, repos, uptime)',
    usage_hint: ' ',
  },
  {
    command: '/workspace',
    description: 'List available workspaces or look up a specific one',
    usage_hint: '[repo-name]',
  },
  {
    command: '/memory',
    description: 'View or manage workspace memories',
    usage_hint: 'list|count|clear <repo>',
  },
  {
    command: '/session',
    description: 'View session overview or inspect a specific session',
    usage_hint: '[thread_ts]',
  },
  {
    command: '/provider',
    description: 'View or switch the AI provider for this thread',
    usage_hint: '[list|reset|<provider-id>]',
  },
  {
    command: '/model',
    description: 'View or switch the AI model for this thread',
    usage_hint: '[list|reset|<model-name>]',
  },
  {
    command: '/version',
    description: 'Show the current bot deployment version (git commit hash)',
    usage_hint: ' ',
  },
];

export const DESIRED_SHORTCUTS: SlackManifestShortcut[] = [
  {
    name: 'Stop Reply',
    type: 'message',
    callback_id: 'stop_reply_action',
    description: "Stop the bot's in-progress reply in this thread",
  },
];

export const DESIRED_BOT_EVENTS = [
  'app_home_opened',
  'message.channels',
  'message.groups',
  'message.im',
] as const;

export const DESIRED_BOT_SCOPES = [
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'commands',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'reactions:read',
  'reactions:write',
  'team:read',
  'users.profile:read',
  'users:read',
  'users:read.email',
];

export function buildManifest(opts: { appName: string; botDisplayName: string }): SlackManifest {
  return {
    display_information: { name: opts.appName },
    features: {
      bot_user: { display_name: opts.botDisplayName, always_online: true },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      slash_commands: DESIRED_COMMANDS,
      shortcuts: DESIRED_SHORTCUTS,
    },
    oauth_config: { scopes: { bot: DESIRED_BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: [...DESIRED_BOT_EVENTS] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}
