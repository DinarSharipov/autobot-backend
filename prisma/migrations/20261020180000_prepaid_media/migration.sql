ALTER TYPE "PublicationStatus" ADD VALUE 'AWAITING_MEDIA';
CREATE TYPE "MediaGenerationStatus" AS ENUM ('QUEUED','RUNNING','UPLOADING','READY','BLOCKED_FUNDS','FAILED','UPLOAD_UNKNOWN');
ALTER TABLE "PublicationMedia"
 ADD COLUMN "generationStatus" "MediaGenerationStatus" NOT NULL DEFAULT 'QUEUED',
 ADD COLUMN "sourceVersionId" UUID,
 ADD COLUMN "approvedTextVersionId" UUID,
 ADD COLUMN "generationAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "leaseToken" UUID,
 ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
 ADD COLUMN "errorCode" TEXT;
-- Pre-existing media references must never turn into new paid generation jobs.
UPDATE "PublicationMedia" SET "generationStatus" = CASE WHEN "telegramFileId" IS NOT NULL THEN 'READY'::"MediaGenerationStatus" ELSE 'FAILED'::"MediaGenerationStatus" END;
ALTER TABLE "PublicationMedia" ADD CONSTRAINT "PublicationMedia_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "PostVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PublicationMedia" ADD CONSTRAINT "PublicationMedia_approvedTextVersionId_fkey" FOREIGN KEY ("approvedTextVersionId") REFERENCES "PostVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PublicationMedia_generationStatus_nextAttemptAt_idx" ON "PublicationMedia"("generationStatus", "nextAttemptAt");
CREATE UNIQUE INDEX "PublicationMedia_one_active_generation" ON "PublicationMedia"("publicationId") WHERE "generationStatus" IN ('QUEUED','RUNNING','UPLOADING','BLOCKED_FUNDS');
CREATE TABLE "MediaCostConfirmation" (
 "id" UUID NOT NULL PRIMARY KEY, "userId" UUID NOT NULL, "publicationId" UUID NOT NULL,
 "publicationVersion" INTEGER NOT NULL, "textVersionId" UUID NOT NULL,
 "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "MediaCostConfirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "MediaCostConfirmation_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "MediaCostConfirmation_publicationId_createdAt_idx" ON "MediaCostConfirmation"("publicationId", "createdAt");
