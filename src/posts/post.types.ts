import type { Post, PostVersion, Publication } from '../generated/prisma/client.js';

export type PostView = {
  id: string;
  channelId: string;
  topicId: string | null;
  title: string | null;
  prompt: string;
  generateImage: boolean;
  publicationMode: Post['publicationMode'];
  status: Post['status'];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type PostVersionView = {
  id: string;
  postId: string;
  publicationId: string | null;
  sequence: number;
  status: PostVersion['status'];
  text: string | null;
  createdAt: string;
  generatedAt: string | null;
};

export type PublicationView = {
  id: string;
  postId: string;
  scheduleId: string | null;
  selectedVersionId: string | null;
  selectedMediaId: string | null;
  scheduledFor: string;
  status: Publication['status'];
  fundingMode: Publication['fundingMode'];
  fundingStatus: Publication['fundingStatus'];
  version: number;
  attemptCount: number;
  nextAttemptAt: string | null;
  telegramChatId: string | null;
  telegramMessageId: string | null;
  publishedWithImage: boolean;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export function toPostView(post: Post): PostView {
  return {
    id: post.id,
    channelId: post.channelId,
    topicId: post.topicId,
    title: post.title,
    prompt: post.prompt,
    generateImage: post.generateImage,
    publicationMode: post.publicationMode,
    status: post.status,
    version: post.version,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
  };
}

export function toPostVersionView(version: PostVersion): PostVersionView {
  return {
    id: version.id,
    postId: version.postId,
    publicationId: version.publicationId,
    sequence: version.sequence,
    status: version.status,
    text: version.text,
    createdAt: version.createdAt.toISOString(),
    generatedAt: version.generatedAt?.toISOString() ?? null,
  };
}

export function toPublicationView(publication: Publication): PublicationView {
  return {
    id: publication.id,
    postId: publication.postId,
    scheduleId: publication.scheduleId,
    selectedVersionId: publication.selectedVersionId,
    selectedMediaId: publication.selectedMediaId,
    scheduledFor: publication.scheduledFor.toISOString(),
    status: publication.status,
    fundingMode: publication.fundingMode,
    fundingStatus: publication.fundingStatus,
    version: publication.version,
    attemptCount: publication.attemptCount,
    nextAttemptAt: publication.nextAttemptAt?.toISOString() ?? null,
    telegramChatId: publication.telegramChatId?.toString() ?? null,
    telegramMessageId: publication.telegramMessageId?.toString() ?? null,
    publishedWithImage: publication.publishedWithImage,
    errorCode: publication.errorCode,
    createdAt: publication.createdAt.toISOString(),
    updatedAt: publication.updatedAt.toISOString(),
    publishedAt: publication.publishedAt?.toISOString() ?? null,
  };
}
