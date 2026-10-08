import 'dotenv/config';

import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // `prisma generate` does not connect, so a non-secret fallback keeps clean
    // checkout builds reproducible. Runtime configuration remains mandatory.
    url:
      process.env.DATABASE_URL ??
      'postgresql://autobot:autobot@localhost:5432/autobot?schema=public&connect_timeout=5',
  },
});
