type BaseJobPayload = {
  schemaVersion: 1;
  requestId?: string;
};

export type PostGenerationJobPayload = BaseJobPayload & {
  publicationId: string;
};

export type PublicationJobPayload = BaseJobPayload & {
  publicationId: string;
};

export type ScheduleMaterializationJobPayload = BaseJobPayload & {
  scheduleId: string;
  expectedVersion: number;
};

export type OutboxDispatchJobPayload = BaseJobPayload & {
  outboxEventId: string;
};

export type QueueJobPayloads = {
  'post-generation': PostGenerationJobPayload;
  publication: PublicationJobPayload;
  scheduling: ScheduleMaterializationJobPayload;
  outbox: OutboxDispatchJobPayload;
};
