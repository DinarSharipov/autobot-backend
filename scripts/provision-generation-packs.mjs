import process from 'node:process';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, CreditType } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const packs = [
  { code: 'text-20', creditType: CreditType.TEXT, units: 20, priceMinor: 9900 },
  { code: 'text-50', creditType: CreditType.TEXT, units: 50, priceMinor: 21900 },
  { code: 'text-100', creditType: CreditType.TEXT, units: 100, priceMinor: 39900 },
  { code: 'image-10', creditType: CreditType.IMAGE, units: 10, priceMinor: 7900 },
  { code: 'image-30', creditType: CreditType.IMAGE, units: 30, priceMinor: 21900 },
  { code: 'image-100', creditType: CreditType.IMAGE, units: 100, priceMinor: 64900 },
];

try {
  for (const pack of packs) {
    await prisma.generationPack.upsert({
      where: { code: pack.code },
      create: { ...pack, currency: 'RUB', version: 1, isActive: true },
      update: {
        creditType: pack.creditType,
        units: pack.units,
        priceMinor: pack.priceMinor,
        currency: 'RUB',
        isActive: true,
      },
    });
  }
  console.log(`Provisioned ${packs.length} generation packs.`);
} finally {
  await prisma.$disconnect();
}
