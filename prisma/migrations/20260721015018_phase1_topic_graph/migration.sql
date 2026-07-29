-- CreateEnum
CREATE TYPE "TopicStatus" AS ENUM ('unanswered', 'answered_weak', 'answered_strong', 'competitor_owned', 'stale');

-- AlterTable
ALTER TABLE "BlogPost" ADD COLUMN     "bodyHtml" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "qa" JSONB,
ADD COLUMN     "scheduledFor" TIMESTAMP(3),
ADD COLUMN     "topicNodeId" TEXT;

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "settings" JSONB,
ADD COLUMN     "siteAudit" JSONB,
ADD COLUMN     "sitemapUrl" TEXT;

-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "settings" JSONB,
ADD COLUMN     "siteAudit" JSONB,
ADD COLUMN     "sitemapUrl" TEXT;

-- CreateTable
CREATE TABLE "SitePage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "contentType" TEXT,
    "title" TEXT,
    "primaryTopic" TEXT,
    "questionsAnswered" JSONB,
    "entities" JSONB,
    "hasSchema" BOOLEAN NOT NULL DEFAULT false,
    "structureScore" INTEGER,
    "wordCount" INTEGER,
    "lastCrawledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SitePage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TopicNode" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT,
    "verticalId" TEXT,
    "question" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "funnelStage" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'taxonomy',
    "status" "TopicStatus" NOT NULL DEFAULT 'unanswered',
    "score" DOUBLE PRECISION,
    "scoreParts" JSONB,
    "evidence" JSONB,
    "answeredByPageId" TEXT,
    "blogPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VisibilitySnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT,
    "verticalId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "summary" JSONB NOT NULL,
    "raw" JSONB,

    CONSTRAINT "VisibilitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OffPageTask" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "evidence" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OffPageTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataFetchLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "cost" DOUBLE PRECISION,
    "liveFetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,

    CONSTRAINT "DataFetchLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SitePage_companyId_contentType_idx" ON "SitePage"("companyId", "contentType");

-- CreateIndex
CREATE UNIQUE INDEX "SitePage_companyId_url_key" ON "SitePage"("companyId", "url");

-- CreateIndex
CREATE INDEX "TopicNode_companyId_status_idx" ON "TopicNode"("companyId", "status");

-- CreateIndex
CREATE INDEX "TopicNode_companyId_score_idx" ON "TopicNode"("companyId", "score");

-- CreateIndex
CREATE UNIQUE INDEX "TopicNode_companyId_locationId_verticalId_question_key" ON "TopicNode"("companyId", "locationId", "verticalId", "question");

-- CreateIndex
CREATE INDEX "VisibilitySnapshot_companyId_capturedAt_idx" ON "VisibilitySnapshot"("companyId", "capturedAt");

-- CreateIndex
CREATE INDEX "OffPageTask_companyId_status_idx" ON "OffPageTask"("companyId", "status");

-- CreateIndex
CREATE INDEX "DataFetchLog_provider_liveFetchedAt_idx" ON "DataFetchLog"("provider", "liveFetchedAt");

-- AddForeignKey
ALTER TABLE "SitePage" ADD CONSTRAINT "SitePage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TopicNode" ADD CONSTRAINT "TopicNode_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VisibilitySnapshot" ADD CONSTRAINT "VisibilitySnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OffPageTask" ADD CONSTRAINT "OffPageTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
