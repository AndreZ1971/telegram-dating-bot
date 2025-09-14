import { Bot, InlineKeyboard } from "grammy";
import { Menu } from "@grammyjs/menu";
import { prisma } from "./db.js";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Fehlende BOT_TOKEN in .env");
  process.exit(1);
}
const bot = new Bot(token);

// Menü
const mainMenu = new Menu("main-menu")
  .text("👤 Mein Profil", ctx => ctx.reply("Nutze /profile"))
  .row()
  .text("🔎 Entdecken", ctx => ctx.reply("Nutze /browse"))
  .row()
  .text("⚙️ Einstellungen", ctx => ctx.reply("Nutze /settings"));

bot.use(mainMenu);

bot.command(["start","help"], async (ctx) => {
  const userId = ctx.from!.id;
  await prisma.user.upsert({
    where: { id: userId },
    update: {
      username: ctx.from?.username ?? undefined,
      firstName: ctx.from?.first_name ?? undefined,
      lang: ctx.from?.language_code ?? undefined
    },
    create: {
      id: userId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lang: ctx.from?.language_code
    }
  });

  await ctx.reply(
    "Willkommen beim Dating-Bot!\\n\\n• /profile\\n• /browse\\n• /settings\\n• /deleteme",
    { reply_markup: mainMenu }
  );
});

// sehr kurzes /settings MVP (nur 18+ Toggle)
bot.command("settings", async (ctx) => {
  const userId = ctx.from!.id;
  const pref = await prisma.preferences.upsert({
    where: { userId },
    create: { userId, showAdult: false },
    update: {}
  });
  const kb = new InlineKeyboard()
    .text(pref.showAdult ? "🔞 18+ AN" : "🔞 18+ AUS", "toggle_adult");
  await ctx.reply("Einstellungen:", { reply_markup: kb });
});

bot.callbackQuery("toggle_adult", async (ctx) => {
  const userId = ctx.from!.id;
  const pref = await prisma.preferences.findUnique({ where: { userId } });
  if (!pref) return ctx.answerCallbackQuery();
  const nextVal = !pref.showAdult;
  await prisma.preferences.update({ where: { userId }, data: { showAdult: nextVal } });
  await ctx.editMessageReplyMarkup({
    reply_markup: new InlineKeyboard().text(nextVal ? "🔞 18+ AN" : "🔞 18+ AUS", "toggle_adult")
  });
  await ctx.answerCallbackQuery(nextVal ? "18+ sichtbar." : "18+ ausgeblendet.");
});

bot.catch(err => console.error(err));

console.log("✅ Bot läuft im Long-Polling. Drück Strg+C zum Beenden.");
bot.start();

