import type { ModerationRequest, PostVersion } from '../generated/prisma/client.js';
import { toPostVersionView, type PostVersionView } from '../posts/post.types.js';

export type ModerationRequestView = {
  id: string;
  postId: string;
  publicationId: string;
  postVersion: PostVersionView;
  status: ModerationRequest['status'];
  feedback: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
};

export function toModerationRequestView(
  request: ModerationRequest & { postVersion: PostVersion },
): ModerationRequestView {
  return {
    id: request.id,
    postId: request.postId,
    publicationId: request.publicationId,
    postVersion: toPostVersionView(request.postVersion),
    status: request.status,
    feedback: request.feedback,
    version: request.version,
    createdAt: request.createdAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
  };
}
