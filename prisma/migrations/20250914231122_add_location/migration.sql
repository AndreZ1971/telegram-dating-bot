-- AlterTable
ALTER TABLE "Preferences" ADD COLUMN "radiusKm" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Profile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" BIGINT NOT NULL,
    "displayName" TEXT,
    "age" INTEGER,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "identity" TEXT,
    "bioSeek" TEXT,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lat" REAL,
    "lon" REAL,
    "city" TEXT,
    "hasLocation" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Profile" ("age", "bioSeek", "createdAt", "displayName", "id", "identity", "isAdult", "updatedAt", "userId", "visible") SELECT "age", "bioSeek", "createdAt", "displayName", "id", "identity", "isAdult", "updatedAt", "userId", "visible" FROM "Profile";
DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
