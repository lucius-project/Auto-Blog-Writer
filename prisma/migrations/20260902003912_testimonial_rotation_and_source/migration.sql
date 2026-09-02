-- AlterTable
ALTER TABLE "Testimonial" ADD COLUMN     "lastUsedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'book',
ADD COLUMN     "usedCount" INTEGER NOT NULL DEFAULT 0;
