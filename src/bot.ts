import { Bot, InlineKeyboard, session, Context, SessionFlavor } from "grammy";
import { Menu } from "@grammyjs/menu";
import { prisma } from "./db.js";

// ---- Session-Typen ----
type SessionData = { awaiting?: "displayName" | "age" | "bioMe" | "bioSeek" };
type MyContext = Context & SessionFlavor<SessionData>;

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Fehlende BOT_TOKEN in .env");
  process.exit(1);
}

// Tipp: Webhook löschen, falls Bot vorher via Webhook lief (für Long-Polling)
// -> per Hand in der Shell: curl -s "https://api.telegram.org/bot<DEIN_TOKEN>/deleteWebhook"

const bot = new Bot<MyContext>(token);

// Session-Middleware aktivieren (muss vor Handlers stehen, die ctx.session nutzen)
bot.use(session({ initial: (): SessionData => ({}) }));

// Menü
const mainMenu = new Menu("main-menu")
  .text("👤 Mein Profil", (ctx) => ctx.reply("Nutze /profile"))
  .row()
  .text("🔎 Entdecken", (ctx) => ctx.reply("Nutze /browse"))
  .row()
  .text("⚙️ Einstellungen", (ctx) => ctx.reply("Nutze /settings"));

bot.use(mainMenu);

// /start & /help
bot.command(["start", "help"], async (ctx) => {
  const userId = ctx.from!.id;
  await prisma.user.upsert({
    where: { id: userId },
    update: {
      username: ctx.from?.username ?? undefined,
      firstName: ctx.from?.first_name ?? undefined,
      lang: ctx.from?.language_code ?? undefined,
    },
    create: {
      id: userId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lang: ctx.from?.language_code,
    },
  });

  await ctx.reply(
    "Willkommen beim Dating-Bot!\n\n• /profile – Profil anlegen/bearbeiten\n• /browse – Profile entdecken\n• /settings – Filter/18+ Einstellungen\n• /deleteme – Profil & Daten löschen",
    { reply_markup: mainMenu }
  );
});

// /settings (MVP: nur 18+ Toggle)
bot.command("settings", async (ctx) => {
  const userId = ctx.from!.id;
  const pref = await prisma.preferences.upsert({
    where: { userId },
    create: { userId, showAdult: false },
    update: {},
  });
  const kb = new InlineKeyboard().text(
    pref.showAdult ? "🔞 18+ AN" : "🔞 18+ AUS",
    "toggle_adult"
  );
  await ctx.reply("Einstellungen:", { reply_markup: kb });
});

bot.callbackQuery("toggle_adult", async (ctx) => {
  const userId = ctx.from!.id;
  const pref = await prisma.preferences.findUnique({ where: { userId } });
  if (!pref) return ctx.answerCallbackQuery();
  const nextVal = !pref.showAdult;
  await prisma.preferences.update({
    where: { userId },
    data: { showAdult: nextVal },
  });
  await ctx.editMessageReplyMarkup({
    reply_markup: new InlineKeyboard().text(
      nextVal ? "🔞 18+ AN" : "🔞 18+ AUS",
      "toggle_adult"
    ),
  });
  await ctx.answerCallbackQuery(
    nextVal ? "18%2B sichtbar." : "18%2B ausgeblendet."
  );
});

// -------- Profil-Onboarding (/profile) --------
bot.command("profile", async (ctx) => {
  ctx.session.awaiting = "displayName";
  await ctx.reply(
    "Gib bitte deinen *Anzeigenamen* ein (max 40 Zeichen).",
    { parse_mode: "Markdown" }
  );
});

// Texteingaben verarbeiten (Schritt-für-Schritt)
bot.on("message:text", async (ctx, next) => {
  const step = ctx.session.awaiting;
  const userId = ctx.from!.id;

  if (step === "displayName") {
    const displayName = ctx.message.text.trim().slice(0, 40);
    await prisma.profile.upsert({
      where: { userId },
      update: { displayName },
      create: { userId, displayName },
    });
    ctx.session.awaiting = "age";
    return ctx.reply("Danke! Wie alt bist du? (Zahl 13–120)");
  }

  if (step === "age") {
    const age = Number(ctx.message.text.trim());
    if (!Number.isInteger(age) || age < 13 || age > 120) {
      return ctx.reply("Bitte eine gültige Zahl 13–120 eingeben.");
    }
    await prisma.profile.update({
      where: { userId },
      data: { age, isAdult: age >= 18 },
    });
    ctx.session.awaiting = "bioMe";
    return ctx.reply("Kurzbeschreibung: *Was bist du?*", {
      parse_mode: "Markdown",
    });
  }

  if (step === "bioMe") {
    await prisma.profile.update({
      where: { userId },
      data: { bioMe: ctx.message.text.slice(0, 500) },
    });
    ctx.session.awaiting = "bioSeek";
    return ctx.reply("Und *was suchst du?*", { parse_mode: "Markdown" });
  }

  if (step === "bioSeek") {
    await prisma.profile.update({
      where: { userId },
      data: { bioSeek: ctx.message.text.slice(0, 500) },
    });
    ctx.session.awaiting = undefined;
    return ctx.reply("✅ Profil gespeichert! /settings für 18+-Optionen.");
  }

  // Kein Onboarding-Schritt aktiv → zum nächsten Handler durchreichen
  return next();
});

// Fehler-Logging
bot.catch((err) => console.error(err));

console.log("✅ Bot läuft im Long-Polling. Drück Strg+C zum Beenden.");
bot.start();
