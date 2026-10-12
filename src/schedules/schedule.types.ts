import type { PostSchedule } from '../generated/prisma/client.js';

export type ScheduleView = {
  id: string;
  postId: string;
  kind: PostSchedule['kind'];
  status: PostSchedule['status'];
  timezone: string;
  runAt: string | null;
  rrule: string | null;
  nextRunAt: string | null;
  lastEvaluatedAt: string | null;
  misfirePolicy: PostSchedule['misfirePolicy'];
  misfireGraceSeconds: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export function toScheduleView(schedule: PostSchedule): ScheduleView {
  return {
    id: schedule.id,
    postId: schedule.postId,
    kind: schedule.kind,
    status: schedule.status,
    timezone: schedule.timezone,
    runAt: schedule.runAt?.toISOString() ?? null,
    rrule: schedule.rrule,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastEvaluatedAt: schedule.lastEvaluatedAt?.toISOString() ?? null,
    misfirePolicy: schedule.misfirePolicy,
    misfireGraceSeconds: schedule.misfireGraceSeconds,
    version: schedule.version,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}
