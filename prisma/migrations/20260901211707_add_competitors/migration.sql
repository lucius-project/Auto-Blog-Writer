-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "label" TEXT,
    "coverage" JSONB,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "gapsFound" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastCrawledAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Competitor_companyId_idx" ON "Competitor"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_companyId_domain_key" ON "Competitor"("companyId", "domain");

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
