-- CreateTable
CREATE TABLE "Testimonial" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT,
    "clientName" TEXT,
    "industry" TEXT,
    "location" TEXT,
    "quote" TEXT NOT NULL,
    "resultClaim" TEXT,
    "metrics" JSONB,
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Testimonial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Testimonial_companyId_industry_idx" ON "Testimonial"("companyId", "industry");
