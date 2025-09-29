import { Context } from "grammy";

const ADMIN_IDS = (process.env.ADMIN_IDS ?? "")
  .split(",").map(s => s.trim()).filter(Boolean);

export function isAdmin(ctx: Context) {
  const id = String(ctx.from?.id ?? "");
  return id && ADMIN_IDS.includes(id);
}