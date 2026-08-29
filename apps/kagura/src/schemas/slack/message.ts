import { z } from 'zod';

const SlackTextObjectSchema = z.looseObject({
  type: z.enum(['plain_text', 'mrkdwn']),
  text: z.string(),
});

const SlackSectionBlockSchema = z.looseObject({
  type: z.literal('section'),
  text: SlackTextObjectSchema.optional(),
  fields: z.array(SlackTextObjectSchema).optional(),
});

const SlackGenericBlockSchema = z.looseObject({
  type: z.string(),
});

export const SlackFileSchema = z.looseObject({
  id: z.string().min(1),
  mimetype: z.string().nullish(),
  filetype: z.string().nullish(),
  name: z.string().nullish(),
  title: z.string().nullish(),
  url_private: z.string().nullish(),
});

export const SlackMessageSchema = z.looseObject({
  channel: z.string().min(1).optional(),
  channel_type: z.string().min(1).optional(),
  team: z.string().min(1).optional(),
  text: z.string().default(''),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  blocks: z.array(z.union([SlackSectionBlockSchema, SlackGenericBlockSchema])).optional(),
  files: z.array(SlackFileSchema).optional(),
});

export type SlackFile = z.infer<typeof SlackFileSchema>;
export type SlackMessage = z.infer<typeof SlackMessageSchema>;
