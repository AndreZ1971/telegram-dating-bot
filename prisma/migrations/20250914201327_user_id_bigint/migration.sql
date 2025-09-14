/*
  Warnings:

  - You are about to alter the column `fromUserId` on the `Like` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `toUserId` on the `Like` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `userId` on the `Preferences` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `userId` on the `Profile` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `reportedUserId` on the `Report` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `reporterUserId` on the `Report` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - The primary key for the `User` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to alter the column `id` on the `User` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Like" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fromUserId" BIGINT NOT NULL,
    "toUserId" BIGINT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Like_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Like_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Like" ("createdAt", "fromUserId", "id", "toUserId") SELECT "createdAt", "fromUserId", "id", "toUserId" FROM "Like";
DROP TABLE "Like";
ALTER TABLE "new_Like" RENAME TO "Like";
CREATE UNIQUE INDEX "Like_fromUserId_toUserId_key" ON "Like"("fromUserId", "toUserId");
CREATE TABLE "new_Preferences" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" BIGINT NOT NULL,
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "showAdult" BOOLEAN NOT NULL DEFAULT false,
    "radiusKm" INTEGER,
    "tagsJson" TEXT,
    CONSTRAINT "Preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Preferences" ("id", "maxAge", "minAge", "radiusKm", "showAdult", "tagsJson", "userId") SELECT "id", "maxAge", "minAge", "radiusKm", "showAdult", "tagsJson", "userId" FROM "Preferences";
DROP TABLE "Preferences";
ALTER TABLE "new_Preferences" RENAME TO "Preferences";
CREATE UNIQUE INDEX "Preferences_userId_key" ON "Preferences"("userId");
CREATE TABLE "new_Profile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" BIGINT NOT NULL,
    "displayName" TEXT NOT NULL,
    "age" INTEGER,
    "bioMe" TEXT,
    "bioSeek" TEXT,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "isSfwOnly" BOOLEAN NOT NULL DEFAULT true,
    "visible" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Profile" ("age", "bioMe", "bioSeek", "displayName", "id", "isAdult", "isSfwOnly", "updatedAt", "userId", "visible") SELECT "age", "bioMe", "bioSeek", "displayName", "id", "isAdult", "isSfwOnly", "updatedAt", "userId", "visible" FROM "Profile";
DROP TABLE "Profile";
ALTER TABLE "new_Profile" RENAME TO "Profile";
CREATE UNIQUE INDEX "Profile_userId_key" ON "Profile"("userId");
CREATE TABLE "new_Report" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "reporterUserId" BIGINT NOT NULL,
    "reportedUserId" BIGINT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Report" ("createdAt", "id", "reason", "reportedUserId", "reporterUserId") SELECT "createdAt", "id", "reason", "reportedUserId", "reporterUserId" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
CREATE TABLE "new_User" (
    "id" BIGINT NOT NULL PRIMARY KEY,
    "username" TEXT,
    "firstName" TEXT,
    "lang" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "firstName", "id", "lang", "username") SELECT "createdAt", "firstName", "id", "lang", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
