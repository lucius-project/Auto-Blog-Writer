-- CreateTable
CREATE TABLE "WebsiteChecklist" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "error" TEXT,
    "items" JSONB,
    "manual" JSONB,
    "liveFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteChecklist_companyId_key" ON "WebsiteChecklist"("companyId");

-- AddForeignKey
ALTER TABLE "WebsiteChecklist" ADD CONSTRAINT "WebsiteChecklist_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
