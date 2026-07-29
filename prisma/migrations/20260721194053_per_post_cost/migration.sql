-- AlterTable
ALTER TABLE "DataFetchLog" ADD COLUMN     "blogPostId" TEXT;

-- CreateIndex
CREATE INDEX "DataFetchLog_blogPostId_idx" ON "DataFetchLog"("blogPostId");
