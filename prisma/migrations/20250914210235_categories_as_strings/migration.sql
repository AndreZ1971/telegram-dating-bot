-- AlterTable
ALTER TABLE "Profile" ADD COLUMN "identity" TEXT;

-- CreateTable
CREATE TABLE "ProfileAudience" (
    "profileId" INTEGER NOT NULL,
    "audience" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("profileId", "audience"),
    CONSTRAINT "ProfileAudience_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
