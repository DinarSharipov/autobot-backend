import type { SchemaObject } from '@nestjs/swagger';
export const mediaSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'publicationId',
    'status',
    'generationStatus',
    'sourceVersionId',
    'approvedTextVersionId',
    'isOutdated',
    'selectionIsCurrent',
    'telegramFileId',
    'telegramFileUniqueId',
    'telegramChatId',
    'telegramMessageId',
    'errorCode',
    'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    publicationId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['PENDING', 'READY', 'SELECTED', 'REJECTED', 'UNAVAILABLE'] },
    generationStatus: {
      type: 'string',
      enum: [
        'QUEUED',
        'RUNNING',
        'UPLOADING',
        'READY',
        'BLOCKED_FUNDS',
        'FAILED',
        'UPLOAD_UNKNOWN',
      ],
    },
    sourceVersionId: { type: 'string', format: 'uuid', nullable: true },
    approvedTextVersionId: { type: 'string', format: 'uuid', nullable: true },
    isOutdated: {
      type: 'boolean',
      description:
        'Source image text differs from the current generated text. No implicit regeneration.',
    },
    selectionIsCurrent: {
      type: 'boolean',
      description: 'Explicit selection was approved for the current text version.',
    },
    telegramFileId: { type: 'string', nullable: true, example: 'telegram-photo-file-id' },
    telegramFileUniqueId: { type: 'string', nullable: true },
    telegramChatId: { type: 'string', nullable: true },
    telegramMessageId: { type: 'string', nullable: true },
    errorCode: { type: 'string', nullable: true, example: 'INSUFFICIENT_IMAGE_CREDITS' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};
export const mediaListSchema: SchemaObject = {
  type: 'object',
  required: ['publicationId', 'publicationVersion', 'selectedMediaId', 'items'],
  properties: {
    publicationId: { type: 'string', format: 'uuid' },
    publicationVersion: { type: 'integer', minimum: 1 },
    selectedMediaId: { type: 'string', format: 'uuid', nullable: true },
    items: { type: 'array', items: mediaSchema, maxItems: 100 },
  },
};
export const mediaCostSchema: SchemaObject = {
  type: 'object',
  required: [
    'publicationId',
    'publicationVersion',
    'textVersionId',
    'creditType',
    'units',
    'available',
    'debt',
    'costConfirmationId',
    'expiresAt',
  ],
  properties: {
    publicationId: { type: 'string', format: 'uuid' },
    publicationVersion: { type: 'integer', minimum: 1 },
    textVersionId: { type: 'string', format: 'uuid' },
    creditType: { type: 'string', enum: ['IMAGE'] },
    units: { type: 'integer', enum: [1] },
    available: { type: 'integer', minimum: 0 },
    debt: { type: 'integer', minimum: 0 },
    costConfirmationId: {
      type: 'string',
      format: 'uuid',
      description:
        'Single-use 10-minute approval bound to owner, publication version and text version. Required for every explicit image generation/replacement.',
    },
    expiresAt: { type: 'string', format: 'date-time' },
  },
};
