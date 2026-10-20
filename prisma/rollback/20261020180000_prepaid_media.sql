-- Run transactionally with stopped API/workers, before prepaid use only.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "Publication" WHERE "fundingMode" = 'PREPAID') THEN
  RAISE EXCEPTION 'Prepaid publications exist: media schema rollback is forbidden';
 END IF;
END $$;
DROP TABLE "MediaCostConfirmation";
ALTER TABLE "PublicationMedia" DROP COLUMN "generationStatus", DROP COLUMN "sourceVersionId", DROP COLUMN "approvedTextVersionId", DROP COLUMN "generationAttempts", DROP COLUMN "nextAttemptAt", DROP COLUMN "leaseToken", DROP COLUMN "leaseExpiresAt", DROP COLUMN "errorCode";
DROP TYPE "MediaGenerationStatus";
-- PostgreSQL enum values are additive: leave unused AWAITING_MEDIA in PublicationStatus.
