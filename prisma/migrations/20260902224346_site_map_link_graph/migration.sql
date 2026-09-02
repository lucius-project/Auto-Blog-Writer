-- AlterTable
ALTER TABLE "SitePage" ADD COLUMN     "inboundInternal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isPillar" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "outboundLinks" JSONB;

-- CreateTable
CREATE TABLE "LinkCheck" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "status" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL,
    "error" TEXT,
    "sources" JSONB,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkCheck_companyId_ok_idx" ON "LinkCheck"("companyId", "ok");

-- CreateIndex
CREATE UNIQUE INDEX "LinkCheck_companyId_targetUrl_key" ON "LinkCheck"("companyId", "targetUrl");

-- AddForeignKey
ALTER TABLE "LinkCheck" ADD CONSTRAINT "LinkCheck_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
