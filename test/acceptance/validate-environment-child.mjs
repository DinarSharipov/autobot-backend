import { readFileSync } from 'node:fs';
import { validateEnvironment } from '../../src/config/environment.ts';
try {
  validateEnvironment(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error.message }));
}
