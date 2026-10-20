-- Run only with API/workers stopped, using psql --single-transaction -v ON_ERROR_STOP=1.
-- Retain the additive schema for normal application rollback after any prepaid use.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "Publication" WHERE "fundingMode" = 'PREPAID') THEN
  RAISE EXCEPTION 'Prepaid publications exist: schema rollback requires reconciliation and is forbidden';
 END IF;
END $$;
DROP TABLE "GenerationCostConfirmation";
ALTER TABLE "Publication" DROP COLUMN "textRevisionRequestId", DROP COLUMN "textFundingKey", DROP COLUMN "textFundingKind", DROP COLUMN "fundingMode";
DROP TYPE "TextFundingKind";
DROP TYPE "PublicationFundingMode";
