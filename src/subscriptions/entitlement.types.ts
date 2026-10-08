import { z } from 'zod';

const quota = z.number().int().nonnegative().nullable();

export const entitlementSchema = z
  .object({
    channelLimit: quota,
    topicLimit: quota,
    textGenerationMonthly: quota,
    imageGenerationMonthly: quota,
    moderationRevisionMonthly: quota,
    imageGenerationEnabled: z.boolean(),
    moderationEnabled: z.boolean(),
  })
  .strict();

export type Entitlements = z.infer<typeof entitlementSchema>;

export const INITIAL_PLANS: ReadonlyArray<{
  code: string;
  name: string;
  isDefault: boolean;
  entitlements: Entitlements;
}> = [
  {
    code: 'free',
    name: 'Free',
    isDefault: true,
    entitlements: {
      channelLimit: 1,
      topicLimit: 3,
      textGenerationMonthly: 30,
      imageGenerationMonthly: 0,
      moderationRevisionMonthly: 0,
      imageGenerationEnabled: false,
      moderationEnabled: false,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    isDefault: false,
    entitlements: {
      channelLimit: 10,
      topicLimit: 50,
      textGenerationMonthly: 1000,
      imageGenerationMonthly: 100,
      moderationRevisionMonthly: 250,
      imageGenerationEnabled: true,
      moderationEnabled: true,
    },
  },
];
