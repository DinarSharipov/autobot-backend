import type { Topic } from '../generated/prisma/client.js';

export type TopicView = {
  id: string;
  name: string;
  description: string | null;
  promptTemplate: string;
  status: Topic['status'];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export function toTopicView(topic: Topic): TopicView {
  return {
    id: topic.id,
    name: topic.name,
    description: topic.description,
    promptTemplate: topic.promptTemplate,
    status: topic.status,
    version: topic.version,
    createdAt: topic.createdAt.toISOString(),
    updatedAt: topic.updatedAt.toISOString(),
  };
}
