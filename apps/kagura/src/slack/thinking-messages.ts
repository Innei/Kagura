// These strings are used for Kagura's own progress/probe text. Slack's current
// Agent Sessions API accepts only lifecycle states such as `processing`, so the
// native loading indicator no longer carries custom loading messages.

// Canonical default string used whenever no tool-specific progress applies.
// All `'Thinking...'` literals across the codebase MUST reference this
// constant so the default can evolve in one place.
export const DEFAULT_ASSISTANT_THINKING_STATUS = 'Thinking...';

export const THINKING_STATUS_MESSAGES = [
  DEFAULT_ASSISTANT_THINKING_STATUS,
  'Gathering thoughts...',
  'Turning the question over...',
  'Following a thread...',
  'Tracing the outline of an answer...',
  'Wandering through ideas...',
  'Weighing words carefully...',
  'Listening to the silence between words...',
  'Looking at it from another angle...',
  'Finding the right words...',
  'Chasing a thought to its source...',
  'Connecting distant dots...',
  'Sketching the shape of a reply...',
  'Reading between the lines...',
  'Walking around the problem...',
  'Weaving fragments into coherence...',
  'Watching the pieces fall into place...',
  'Holding the question lightly...',
  'Letting the answer surface...',
  'Paying attention to what matters...',
] as const;

export function rotateThinkingStatus(index: number): string {
  return THINKING_STATUS_MESSAGES[index % THINKING_STATUS_MESSAGES.length]!;
}

export const THINKING_LOADING_MESSAGES = [
  'Gathering threads of thought...',
  'Reading between the lines...',
  'Following where the question leads...',
  'Turning the problem over in mind...',
  'Tracing the shape of an answer...',
  'Weaving ideas together...',
  'Connecting distant dots...',
  'Listening for what is unspoken...',
  'Walking around the problem...',
  'Watching pieces fall into place...',
  'Holding the question lightly...',
  'Letting the answer surface...',
  'Sketching the outline of a reply...',
  'Weighing each word...',
  'Chasing a thread to its source...',
  'Finding the right words...',
  'Looking from another angle...',
  'Paying attention to detail...',
  'Building understanding layer by layer...',
  'Sensing the contours of the problem...',
  'Placing each stone with care...',
  'Wandering through the possibility space...',
  'Gathering light from different windows...',
  'Sitting with the question a moment longer...',
  'Drawing from stillness...',
] as const;

export function getShuffledThinkingMessages(count: number = 8): string[] {
  const shuffled = [...THINKING_LOADING_MESSAGES];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = shuffled[i]!;
    const next = shuffled[j]!;
    shuffled[i] = next;
    shuffled[j] = current;
  }
  return shuffled.slice(0, count);
}
