-- CreateTable
CREATE TABLE "BatchRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "total" INTEGER NOT NULL,
    "written" INTEGER NOT NULL DEFAULT 0,
    "scheduled" INTEGER NOT NULL DEFAULT 0,
    "skippedQa" INTEGER NOT NULL DEFAULT 0,
    "skippedDup" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "currentTitle" TEXT,
    "currentStep" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BatchRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchRun_companyId_startedAt_idx" ON "BatchRun"("companyId", "startedAt");
