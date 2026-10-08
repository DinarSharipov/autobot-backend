-- DropIndex
DROP INDEX "Session_userId_revokedAt_idx";

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_expiresAt_idx" ON "Session"("userId", "revokedAt", "expiresAt");
