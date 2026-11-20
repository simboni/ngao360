-- CreateEnum
CREATE TYPE "DataProvenance" AS ENUM ('SYNTHETIC', 'HISTORICAL', 'LIVE');

-- AlterTable
ALTER TABLE "election_cycles" ADD COLUMN     "data_provenance" "DataProvenance" NOT NULL DEFAULT 'LIVE';

