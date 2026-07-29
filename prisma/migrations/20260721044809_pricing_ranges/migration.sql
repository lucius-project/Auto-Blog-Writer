-- CreateTable
CREATE TABLE "PricingRange" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'per user/month',
    "low" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PricingRange_companyId_idx" ON "PricingRange"("companyId");
