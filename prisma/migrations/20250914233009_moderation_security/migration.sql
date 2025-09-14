-- CreateTable
CREATE TABLE "ModAction" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" BIGINT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "targetUserId" BIGINT,
    "targetProfileId" INTEGER,
    "targetPhotoId" INTEGER,
    CONSTRAINT "ModAction_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Photo" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "profileId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" DATETIME,
    "removedReason" TEXT,
    "removedByUserId" BIGINT,
    CONSTRAINT "Photo_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Photo" ("createdAt", "fileId", "id", "isPrimary", "profileId") SELECT "createdAt", "fileId", "id", "isPrimary", "profileId" FROM "Photo";
DROP TABLE "Photo";
ALTER TABLE "new_Photo" RENAME TO "Photo";
CREATE INDEX "Photo_profileId_idx" ON "Photo"("profileId");
CREATE INDEX "Photo_removed_idx" ON "Photo"("removed");
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
    "suspended" BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt" DATETIME,
    "suspendedReason" TEXT,
    "suspendedByUserId" BIGINT,
    "shadowbanned" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Profile" ("age", "bioSeek", "city", "createdAt", "displayName", "hasLocation", "id", "identity", "isAdult", "lat", "lon", "updatedAt", "userId", "visible") SELECT "age", "bioSeek", "city", "createdAt", "displayName", "hasLocation", "id", "identity", "isAdult", "lat", "lon", "updatedAt", "userId", "visible" FROM "Profile";
DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");
CREATE INDEX "Profile_visible_idx" ON "Profile"("visible");
CREATE INDEX "Profile_suspended_idx" ON "Profile"("suspended");
CREATE INDEX "Profile_shadowbanned_idx" ON "Profile"("shadowbanned");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ModAction_createdAt_idx" ON "ModAction"("createdAt");

-- CreateIndex
CREATE INDEX "ModAction_action_idx" ON "ModAction"("action");

-- CreateIndex
CREATE INDEX "ModAction_targetUserId_idx" ON "ModAction"("targetUserId");

-- CreateIndex
CREATE INDEX "ModAction_targetProfileId_idx" ON "ModAction"("targetProfileId");

-- CreateIndex
CREATE INDEX "ModAction_targetPhotoId_idx" ON "ModAction"("targetPhotoId");
