import type { Context } from "grammy";

export async function handleCancel(ctx: Context) {
  // TODO: echte Logik einhängen
  await ctx.reply("❌ Vorgang abgebrochen.");
}
