CREATE TYPE "PublicationFundingMode" AS ENUM ('LEGACY', 'PREPAID');
CREATE TYPE "TextFundingKind" AS ENUM ('INITIAL_TEXT', 'INCLUDED_REVISION', 'PAID_REVISION');
-- Historical publications retain their original subscription funding path.
ALTER TABLE "Publication"
 ADD COLUMN "fundingMode" "PublicationFundingMode" NOT NULL DEFAULT 'LEGACY',
 ADD COLUMN "textFundingKind" "TextFundingKind" NOT NULL DEFAULT 'INITIAL_TEXT',
 ADD COLUMN "textFundingKey" TEXT,
 ADD COLUMN "textRevisionRequestId" UUID;
ALTER TABLE "Publication" ADD CONSTRAINT "Publication_textRevisionRequestId_fkey"
 FOREIGN KEY ("textRevisionRequestId") REFERENCES "ModerationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "GenerationCostConfirmation" (
 "id" UUID NOT NULL PRIMARY KEY,
 "userId" UUID NOT NULL,
 "publicationId" UUID NOT NULL,
 "moderationRequestId" UUID NOT NULL,
 "moderationVersion" INTEGER NOT NULL,
 "allowanceVersion" INTEGER NOT NULL,
 "units" INTEGER NOT NULL CHECK ("units" IN (0, 1)),
 "expiresAt" TIMESTAMP(3) NOT NULL,
 "consumedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "GenerationCostConfirmation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "GenerationCostConfirmation_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "Publication"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "GenerationCostConfirmation_moderationRequestId_fkey" FOREIGN KEY ("moderationRequestId") REFERENCES "ModerationRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "GenerationCostConfirmation_publicationId_createdAt_idx" ON "GenerationCostConfirmation"("publicationId", "createdAt");
