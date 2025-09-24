// src/db.ts
import pkg from "@prisma/client";         // <-- default import statt named
export const prisma = new pkg.PrismaClient();

