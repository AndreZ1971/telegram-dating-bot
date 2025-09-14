import "dotenv/config";
import { Bot, InlineKeyboard, session, Context, SessionFlavor } from "grammy";
import { Menu } from "@grammyjs/menu";
import { prisma } from "./db.js";

// ---- String-basierte "Enums" (SQLite kann keine Prisma-Enums) ----
const IDENTITIES = [
  "MALE",
  "FEMALE",
  "TRANS_WOMAN",
  "TRANS_MAN",
  "NONBINARY",
  "COUPLE",
  "OTHER",
] as const;
type Identity = typeof IDENTITIES[number];

const AUDIENCES = [
  "WOMEN",
  "MEN",
  "TRANS_WOMEN",
  "TRANS_MEN",
  "NONBINARY_PEOPLE",
  "COUPLES",
  "ANY",
] as const;
type Audience = typeof AUDIENCES[number];

// ---- Labels für Buttons/Anzeige ----
const identityLabels: Record<Identity, string> = {
  MALE: "Er (♂)",
  FEMALE: "Sie (♀)",
  TRANS_WOMAN: "Trans-Frau",
  TRANS_MAN: "Trans-Mann",
  NONBINARY: "Nicht-binär",
  COUPLE: "Paar",
  OTHER: "Andere*",
};
const audienceLabels: Record<Audience, string> = {
  WOMEN: "Sucht: Frauen",
  MEN: "Sucht: Männer",
  TRANS_WOMEN: "Sucht: Trans-Frauen",
  TRANS_MEN: "Sucht: Trans-Männer",
  NONBINARY_PEOPLE: "Sucht: Nicht-binär",
  COUPLES: "Sucht: Paare",
  ANY: "Sucht: Offen/Alle",
};

// ---- Tastaturen ----
function kbIdentity(): InlineKeyboard {
  const kb = new InlineKeyboard();
  IDENTITIES.forEach((key, idx) => {
    kb.text(identityLabels[key], `set_ident_${key}`);
    if ((idx + 1) % 2 === 0) kb.row();
  });
  return kb;
}
function kbLooking(selected: Audience[] = []): InlineKeyboard {
  const kb = new InlineKeyboard();
  AUDIENCES.forEach((key, idx) => {
    const isOn = selected.includes(key);
    kb.text(`${isOn ? "✅" : "☐"} ${audienceLabels[key]}`, `toggle_lf_${key}`);
    if ((idx + 1) % 2 === 0) kb.row();
  });
  kb.row().text("✅ Fertig", "lf_done").text("↩️ Zurück", "lf_back");
  return kb;
}

// ---- Session-Typen ----
type SessionData = {
  awaiting?: "displayName" | "age" | "bioMe" | "bioSeek";
  tmpIdentity?: Identity;
  tmpLooking?: Audience[]; // Mehrfachauswahl
};
type MyContext = Context & SessionFlavor<SessionData>;

// ---- Bot Init ----
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Fehlende BOT_TOKEN in .env");
  process.exit(1);
}
const bot = new Bot<MyContext>(token);
bot.use(session({ initial: (): SessionData => ({}) }));

// ---- Menü ----
const mainMenu = new Menu("main-menu")
  .text("👤 Mein Profil", (ctx) => ctx.reply("Nutze /profile"))
  .row()
  .text("🧭 Kategorien", (ctx) => ctx.reply("Nutze /categories"))
  .row()
  .text("⚙️ Einstellungen", (ctx) => ctx.reply("Nutze /settings"));
bot.use(mainMenu);

// -------- /start & /help --------
bot.command(["start", "help"], async (ctx) => {
  const userId = BigInt(ctx.from!.id);
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
    "Willkommen beim Dating-Bot!\n\n• /profile – Profil anlegen/bearbeiten\n• /categories – Identität & wen du suchst\n• /settings – Filter/18+ Einstellungen\n• /deleteme – Profil & Daten löschen",
    { reply_markup: mainMenu }
  );
});

// -------- /settings (MVP: nur 18+ Toggle) --------
bot.command("settings", async (ctx) => {
  const userId = BigInt(ctx.from!.id);
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
  const userId = BigInt(ctx.from!.id);
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
  await ctx.answerCallbackQuery(nextVal ? "18+ sichtbar." : "18+ ausgeblendet.");
});

// -------- Profil-Onboarding (/profile) --------
bot.command("profile", async (ctx) => {
  ctx.session.awaiting = "displayName";
  await ctx.reply("Gib bitte deinen *Anzeigenamen* ein (max 40 Zeichen).", {
    parse_mode: "Markdown",
  });
});
bot.on("message:text", async (ctx, next) => {
  const step = ctx.session.awaiting;
  const userId = BigInt(ctx.from!.id);

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
    return ctx.reply(
      "✅ Profil gespeichert! /categories für Identität & wen du suchst. /settings für 18+-Optionen."
    );
  }

  return next();
});

// -------- Kategorien (/categories) --------
bot.command("categories", async (ctx) => {
  const userId = BigInt(ctx.from!.id);
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) {
    return ctx.reply("Bitte erst ein Profil anlegen: /profile");
  }
  // Vorbelegen aus DB
  ctx.session.tmpIdentity = (profile.identity as Identity | undefined) ?? undefined;
  const existing = await prisma.profileAudience.findMany({
    where: { profileId: profile.id },
  });
  ctx.session.tmpLooking = existing
    .map((e) => e.audience as Audience)
    .filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a));

  await ctx.reply("Wer bist du? (Identität auswählen)", {
    reply_markup: kbIdentity(),
  });
});
bot.callbackQuery(/^set_ident_(.+)$/, async (ctx) => {
  const raw = ctx.match![1] as Identity;
  if (!(IDENTITIES as readonly string[]).includes(raw)) return ctx.answerCallbackQuery("Ungültige Wahl.");
  const userId = BigInt(ctx.from!.id);
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) return ctx.answerCallbackQuery();

  // Temporär + in DB speichern
  ctx.session.tmpIdentity = raw;
  await prisma.profile.update({
    where: { id: profile.id },
    data: { identity: raw },
  });

  const selected = ctx.session.tmpLooking ?? [];
  await ctx.editMessageText(
    `Identität: *${identityLabels[raw]}*\n\nWen suchst du? (Mehrfachauswahl möglich)`,
    { parse_mode: "Markdown", reply_markup: kbLooking(selected) }
  );
});
bot.callbackQuery(/^toggle_lf_(.+)$/, async (ctx) => {
  const key = ctx.match![1] as Audience;
  if (!(AUDIENCES as readonly string[]).includes(key)) return ctx.answerCallbackQuery("Ungültig.");
  const sel = new Set(ctx.session.tmpLooking ?? []);
  sel.has(key) ? sel.delete(key) : sel.add(key);
  ctx.session.tmpLooking = Array.from(sel);
  await ctx.editMessageReplyMarkup({
    reply_markup: kbLooking(ctx.session.tmpLooking),
  });
  await ctx.answerCallbackQuery("Aktualisiert");
});
bot.callbackQuery("lf_back", async (ctx) => {
  await ctx.editMessageText("Wer bist du? (Identität auswählen)", {
    reply_markup: kbIdentity(),
  });
});
bot.callbackQuery("lf_done", async (ctx) => {
  const userId = BigInt(ctx.from!.id);
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) return ctx.answerCallbackQuery();

  const selected = (ctx.session.tmpLooking ?? []).filter((a) =>
    (AUDIENCES as readonly string[]).includes(a)
  );

  // DB: vorhandene Einträge ersetzen
  await prisma.profileAudience.deleteMany({ where: { profileId: profile.id } });
  if (selected.length) {
    await prisma.profileAudience.createMany({
      data: selected.map((a) => ({ profileId: profile.id, audience: a })),
    });
  }

  const identityText = profile.identity && (IDENTITIES as readonly string[]).includes(profile.identity)
    ? identityLabels[profile.identity as Identity]
    : "—";
  const lookingText = selected.length
    ? selected.map((a) => audienceLabels[a]).join(", ")
    : "—";

  await ctx.editMessageText(
    `✅ Gespeichert.\n\nIdentität: *${identityText}*\nSucht: ${lookingText}\n\nTipp: Ergänze noch deinen Suchtext mit /profile (Schritt „was du suchst“).`,
    { parse_mode: "Markdown" }
  );

  ctx.session.tmpIdentity = undefined;
  ctx.session.tmpLooking = undefined;
});

// -------- Fehler-Logging & Start --------
bot.catch((err) => console.error(err));

console.log("✅ Bot läuft im Long-Polling. Drück Strg+C zum Beenden.");
bot.start();
