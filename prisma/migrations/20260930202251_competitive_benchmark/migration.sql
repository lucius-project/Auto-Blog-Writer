-- AlterTable
ALTER TABLE "Location" ADD COLUMN     "serpLocationCode" INTEGER;

-- CreateTable
CREATE TABLE "BenchmarkQuery" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "verticalId" TEXT,
    "query" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'auto',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenchmarkQuery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "queriesTotal" INTEGER NOT NULL DEFAULT 0,
    "queriesProbed" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "error" TEXT,

    CONSTRAINT "BenchmarkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "verticalId" TEXT,
    "query" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "liveFetchedAt" TIMESTAMP(3) NOT NULL,
    "organic" JSONB NOT NULL,
    "localPack" JSONB NOT NULL,
    "aiOverview" JSONB NOT NULL,
    "hasAiOverview" BOOLEAN NOT NULL,

    CONSTRAINT "BenchmarkResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BenchmarkQuery_companyId_idx" ON "BenchmarkQuery"("companyId");

-- CreateIndex
CREATE INDEX "BenchmarkRun_companyId_startedAt_idx" ON "BenchmarkRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "BenchmarkResult_runId_idx" ON "BenchmarkResult"("runId");

-- CreateIndex
CREATE INDEX "BenchmarkResult_companyId_idx" ON "BenchmarkResult"("companyId");

-- AddForeignKey
ALTER TABLE "BenchmarkQuery" ADD CONSTRAINT "BenchmarkQuery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkRun" ADD CONSTRAINT "BenchmarkRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkResult" ADD CONSTRAINT "BenchmarkResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BenchmarkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
