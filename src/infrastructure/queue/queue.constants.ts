export const QUEUE_NAMES = {
  postGeneration: 'post-generation',
  publication: 'publication',
  scheduling: 'scheduling',
  outbox: 'outbox',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
