-- AlterTable
ALTER TABLE "AnalyticsConnection" ADD COLUMN     "gscLastSyncError" TEXT,
ADD COLUMN     "gscLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "gscSiteUrl" TEXT;

-- CreateTable
CREATE TABLE "SearchConsoleSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rangeDays" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "liveFetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchConsoleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SearchConsoleSnapshot_companyId_capturedAt_idx" ON "SearchConsoleSnapshot"("companyId", "capturedAt");

-- AddForeignKey
ALTER TABLE "SearchConsoleSnapshot" ADD CONSTRAINT "SearchConsoleSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
