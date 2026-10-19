import { chmod, writeFile } from 'node:fs/promises';
import process from 'node:process';

const outputPath = process.argv[2];

if (!outputPath) {
  throw new Error('Usage: node scripts/ci/render-yookassa-env.mjs <output-path>');
}

const required = [
  'AUTOBOT_API_IMAGE',
  'AUTOBOT_MIGRATION_IMAGE',
  'BUILD_SHA',
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY',
];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  throw new Error(`Missing YooKassa configuration: ${missing.join(', ')}`);
}

const contents = required.map((name) => `${name}=${JSON.stringify(process.env[name])}`).join('\n');

await writeFile(outputPath, `${contents}\n`, { encoding: 'utf8', mode: 0o600 });
await chmod(outputPath, 0o600);
