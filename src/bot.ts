import "dotenv/config";
import { Bot, InlineKeyboard, session, Context, SessionFlavor } from "grammy";
import { Menu } from "@grammyjs/menu";
import { prisma } from "./db.js";

/**
 * ---------------------------
 *  String-"Enums" (SQLite-safe)
 * ---------------------------
 */
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

/**
 * ---------------------------
 *  Tags (Quick-Buttons & Limits)
 * ---------------------------
 */
const QUICK_TAGS = [
  "Outdoor", "Reisen", "Wandern", "Fitness",
  "Kaffee", "Kochen", "Essen gehen", "Kino",
  "Musik", "Konzerte", "Gaming", "Fotografie",
  "Kunst", "Bücher", "Tiere", "Motorrad",
] as const;

const MAX_TAGS_PER_PROFILE = 10;

const slugify = (s: string) =>
  s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 30);

/**
 * ---------------------------
 *  Session / Wizard / Browse
 * ---------------------------
 */
type WizardStep =
  | "idle"
  | "displayName"
  | "age"
  | "identity"
  | "looking"
  | "bioSeek"
  | "confirm"
  | "tagsAdd"; // Freitext-Eingabe für /tags

type TempProfile = {
  displayName?: string;
  age?: number;
  identity?: Identity;
  looking?: Audience[];
  bioSeek?: string;
};

type BrowseState = {
  queue: number[];         // Profile IDs
  index: number;           // aktueller Index
  currentProfileId?: number;
};

type SessionData = {
  step: WizardStep;
  temp: TempProfile;
  browse?: BrowseState;
};

type MyContext = Context & SessionFlavor<SessionData>;

/**
 * ---------------------------
 *  Utilities
 * ---------------------------
 */
const requireToken = () => {
  const t = process.env.BOT_TOKEN;
  if (!t) {
    console.error("Fehlende BOT_TOKEN in .env");
    process.exit(1);
  }
  return t;
};

const userIdOf = (ctx: Context) => BigInt(ctx.from!.id);

/** Simple in-memory rate limiter */
const rate = new Map<string, { count: number; resetAt: number }>();
function checkRate(userId: bigint, action: string, limit: number, windowMs: number) {
  const key = `${userId}:${action}`;
  const now = Date.now();
  const entry = rate.get(key);
  if (!entry || now >= entry.resetAt) {
    rate.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (entry.count < limit) {
    entry.count += 1;
    return { ok: true };
  }
  const msLeft = entry.resetAt - now;
  const minutes = Math.ceil(msLeft / 60000);
  return { ok: false, minutesLeft: minutes };
}

const kbIdentity = () => {
  const kb = new InlineKeyboard();
  IDENTITIES.forEach((k, i) => {
    kb.text(identityLabels[k], `ident:${k}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  return kb.row().text("↩️ Zurück", "back:identity");
};

const kbLooking = (selected: Audience[] = []) => {
  const kb = new InlineKeyboard();
  AUDIENCES.forEach((k, i) => {
    const on = selected.includes(k);
    kb.text(`${on ? "✅" : "☐"} ${audienceLabels[k]}`, `look:${k}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  return kb.row().text("↩️ Zurück", "back:looking").text("✅ Weiter", "next:looking");
};

const renderSummary = (p: TempProfile) => {
  const idText = p.identity ? identityLabels[p.identity] : "—";
  const lookText = (p.looking && p.looking.length)
    ? p.looking.map((a) => audienceLabels[a]).join(", ")
    : "—";
  const ageText = p.age ?? "—";
  const dn = p.displayName ?? "—";
  const bs = p.bioSeek?.trim() || "—";
  return `*Zusammenfassung*\n\n• Anzeigename: *${dn}*\n• Alter: *${ageText}*\n• Identität: *${idText}*\n• Sucht: *${lookText}*\n• Suchtext: ${bs}`;
};

const isTempComplete = (p: TempProfile) =>
  !!(p.displayName && p.age && p.identity && p.looking && p.looking.length);

const identityToAudience = (id: Identity): Audience => {
  switch (id) {
    case "MALE": return "MEN";
    case "FEMALE": return "WOMEN";
    case "TRANS_WOMAN": return "TRANS_WOMEN";
    case "TRANS_MAN": return "TRANS_MEN";
    case "NONBINARY": return "NONBINARY_PEOPLE";
    case "COUPLE": return "COUPLES";
    case "OTHER": return "ANY";
  }
};

const formatProfileCard = (p: {
  displayName: string;
  age: number | null;
  identity: string | null;
  bioSeek: string | null;
  audiences: { audience: string }[];
  profileTags?: { tag: { label: string } }[];
}) => {
  const idLabel = p.identity && (IDENTITIES as readonly string[]).includes(p.identity as Identity)
    ? identityLabels[p.identity as Identity]
    : "—";
  const seeks = p.audiences
    .map((a) => a.audience)
    .filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a))
    .map((a) => audienceLabels[a])
    .join(", ") || "—";
  const age = p.age ?? "—";
  const bio = p.bioSeek?.trim() || "—";
  const tags = p.profileTags?.map((pt) => `#${pt.tag.label.replace(/\s+/g, "")}`) ?? [];
  const tagsLine = tags.length ? `\nTags: ${tags.slice(0, 6).join(" ")}` : "";
  return `${p.displayName}, ${age} · ${idLabel}\nSucht: ${seeks}\n„${bio}”${tagsLine}`;
};

const usernameOrLink = (u: { username: string | null; id: bigint }) => {
  if (u.username) return `@${u.username}`;
  return `tg://user?id=${u.id.toString()}`;
};

const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => decodeURIComponent(s);

/**
 * ---------------------------
 *  Bot Init + Middleware
 * ---------------------------
 */
const token = requireToken();
const bot = new Bot<MyContext>(token);

bot.use(
  session({
    initial: (): SessionData => ({ step: "idle", temp: {} }),
  })
);

/**
 * ---------------------------
 *  Menü
 * ---------------------------
 */
const mainMenu = new Menu("main-menu")
  .text("🧭 Profil einrichten", (ctx) => startWizard(ctx))
  .row()
  .text("👤 Mein Profil", (ctx) => showMyProfile(ctx))
  .row()
  .text("🖼️ Fotos", (ctx) => showPhotos(ctx as MyContext))
  .row()
  .text("🏷️ Tags", (ctx) => showTags(ctx as MyContext))
  .row()
  .text("🔎 Entdecken", (ctx) => startBrowse(ctx));

bot.use(mainMenu);

/**
 * ---------------------------
 *  Onboarding Wizard (unverändert)
 * ---------------------------
 */
async function startWizard(ctx: MyContext, edit = false) {
  const id = userIdOf(ctx);

  await prisma.user.upsert({
    where: { id },
    update: {
      username: ctx.from?.username ?? undefined,
      firstName: ctx.from?.first_name ?? undefined,
      lang: ctx.from?.language_code ?? undefined,
    },
    create: {
      id,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lang: ctx.from?.language_code,
    },
  });

  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  let looking: Audience[] = [];
  if (prof) {
    const auds = await prisma.profileAudience.findMany({ where: { profileId: prof.id } });
    looking = auds
      .map((a) => a.audience as Audience)
      .filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a));
  }

  ctx.session.temp = {
    displayName: prof?.displayName,
    age: prof?.age ?? undefined,
    identity: (prof?.identity as Identity | undefined) ?? undefined,
    bioSeek: prof?.bioSeek ?? undefined,
    looking,
  };

  ctx.session.step = "displayName";
  await ctx.reply(
    edit
      ? "✏️ *Profil bearbeiten* (Schritt 1/6)\n\nGib bitte deinen *Anzeigenamen* ein (max 40 Zeichen)."
      : "🚀 *Profil einrichten* (Schritt 1/6)\n\nGib bitte deinen *Anzeigenamen* ein (max 40 Zeichen).",
    { parse_mode: "Markdown" }
  );
}

async function goNext(ctx: MyContext) {
  const step = ctx.session.step;
  const p = ctx.session.temp;

  if (step === "displayName") {
    ctx.session.step = "age";
    return ctx.reply("Schritt 2/6 — Wie alt bist du? (Zahl 13–120)");
  }

  if (step === "age") {
    ctx.session.step = "identity";
    return ctx.reply("Schritt 3/6 — Wer bist du? (Identität auswählen)", {
      reply_markup: kbIdentity(),
    });
  }

  if (step === "identity") {
    ctx.session.step = "looking";
    return ctx.reply("Schritt 4/6 — Wen suchst du? (Mehrfachauswahl möglich)", {
      reply_markup: kbLooking(p.looking ?? []),
    });
  }

  if (step === "looking") {
    ctx.session.step = "bioSeek";
    return ctx.reply(
      "Schritt 5/6 — Optional: *Was suchst du genau?* (kurzer Freitext, max. 500 Zeichen)",
      { parse_mode: "Markdown" }
    );
  }

  if (step === "bioSeek") {
    ctx.session.step = "confirm";
    return ctx.reply(`Schritt 6/6 — ${renderSummary(p)}\n\nAlles korrekt?`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Speichern", "confirm:save")
        .text("↩️ Zurück", "confirm:back"),
    });
  }
}

async function goBack(ctx: MyContext) {
  const step = ctx.session.step;

  if (step === "age") {
    ctx.session.step = "displayName";
    return ctx.reply("Schritt 1/6 — Gib bitte deinen *Anzeigenamen* ein (max 40 Zeichen).", {
      parse_mode: "Markdown",
    });
  }
  if (step === "identity") {
    ctx.session.step = "age";
    return ctx.reply("Schritt 2/6 — Wie alt bist du? (Zahl 13–120)");
  }
  if (step === "looking") {
    ctx.session.step = "identity";
    return ctx.reply("Schritt 3/6 — Wer bist du? (Identität auswählen)", {
      reply_markup: kbIdentity(),
    });
  }
  if (step === "bioSeek") {
    ctx.session.step = "looking";
    return ctx.reply("Schritt 4/6 — Wen suchst du? (Mehrfachauswahl möglich)", {
      reply_markup: kbLooking(ctx.session.temp.looking ?? []),
    });
  }
  if (step === "confirm") {
    ctx.session.step = "bioSeek";
    return ctx.reply(
      "Schritt 5/6 — Optional: *Was suchst du genau?* (kurzer Freitext, max. 500 Zeichen)",
      { parse_mode: "Markdown" }
    );
  }
}

/**
 * ---------------------------
 *  Commands
 * ---------------------------
 */
bot.command(["start", "help"], async (ctx) => {
  const id = userIdOf(ctx);
  await prisma.user.upsert({
    where: { id },
    update: {
      username: ctx.from?.username ?? undefined,
      firstName: ctx.from?.first_name ?? undefined,
      lang: ctx.from?.language_code ?? undefined,
    },
    create: {
      id,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
      lang: ctx.from?.language_code,
    },
  });

  await ctx.reply(
    "Willkommen beim Dating-Bot!\n\n• /profile – Profil einrichten/bearbeiten\n• /myprofile – Profilkarte anzeigen\n• /photos – Fotos verwalten (1–3)\n• /tags – Interessen setzen\n• /browse – Profile entdecken\n• /settings – 18+ & Altersfilter\n• /deleteme – Profil & Daten löschen\n• /cancel – aktuellen Vorgang abbrechen",
    { reply_markup: mainMenu }
  );
});

bot.command("profile", async (ctx) => startWizard(ctx));
bot.command("cancel", async (ctx) => {
  ctx.session.step = "idle";
  ctx.session.temp = {};
  await ctx.reply("❌ Abgebrochen. Du kannst jederzeit mit /profile neu starten.");
});
bot.command("myprofile", async (ctx) => showMyProfile(ctx));
bot.command("browse", async (ctx) => startBrowse(ctx));
bot.command("photos", async (ctx) => showPhotos(ctx as MyContext));
bot.command("tags", async (ctx) => showTags(ctx as MyContext));

/**
 * ---------------------------
 *  /myprofile
 * ---------------------------
 */
async function showMyProfile(ctx: MyContext) {
  const id = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({
    where: { userId: id },
    include: {
      audiences: true,
      profileTags: { include: { tag: true } },
    },
  });

  if (!prof) {
    return ctx.reply("Du hast noch kein Profil. Starte mit /profile.");
  }

  const card = formatProfileCard(prof);
  const kb = new InlineKeyboard()
    .text("✏️ Bearbeiten", "edit_profile")
    .text("🖼️ Fotos", "go_photos")
    .row()
    .text("🏷️ Tags", "go_tags")
    .text("🔎 Entdecken", "go_browse");

  await ctx.reply(card, { reply_markup: kb });
}

bot.callbackQuery("edit_profile", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startWizard(ctx as MyContext, true);
});
bot.callbackQuery("go_browse", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startBrowse(ctx as MyContext);
});
bot.callbackQuery("go_photos", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPhotos(ctx as MyContext);
});
bot.callbackQuery("go_tags", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showTags(ctx as MyContext);
});

/**
 * ---------------------------
 *  Fotos (/photos) – unverändert aus deiner Version
 * ---------------------------
 */
async function showPhotos(ctx: MyContext) {
  const id = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const photos = await prisma.photo.findMany({
    where: { profileId: prof.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
  });

  await ctx.reply(
    `📸 *Deine Fotos* (${photos.length}/3)\n` +
    `• Sende mir ein Bild, um es hinzuzufügen.\n` +
    `• Tippe „⭐️ Primär“, um das Hauptbild festzulegen.\n` +
    `• „🗑️ Löschen“ entfernt es wieder.`,
    { parse_mode: "Markdown" }
  );

  if (photos.length === 0) return;

  for (const ph of photos) {
    const kb = new InlineKeyboard()
      .text(ph.isPrimary ? "⭐️ Primär" : "☆ Primär setzen", `photo:set:${ph.id}`)
      .text("🗑️ Löschen", `photo:del:${ph.id}`);
    await ctx.replyWithPhoto(ph.fileId, {
      caption: ph.isPrimary ? "Primärbild" : "Sekundärbild",
      reply_markup: kb,
    });
  }
}

bot.on("message:photo", async (ctx) => {
  const id = userIdOf(ctx);
  const limit = checkRate(id, "upload_photo", 20, 60 * 60 * 1000);
  if (!limit.ok) return ctx.reply(`Zu viele Uploads. Bitte versuche es in ~${limit.minutesLeft} Min. erneut.`);

  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const count = await prisma.photo.count({ where: { profileId: prof.id } });
  if (count >= 3) return ctx.reply("Du hast bereits 3 Fotos. Lösche zuerst eines mit 🗑️.");

  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  const fileId = largest.file_id;

  const hasPrimary = await prisma.photo.findFirst({
    where: { profileId: prof.id, isPrimary: true },
  });

  const saved = await prisma.photo.create({
    data: { profileId: prof.id, fileId, isPrimary: !hasPrimary },
  });

  const kb = new InlineKeyboard()
    .text(saved.isPrimary ? "⭐️ Primär" : "☆ Primär setzen", `photo:set:${saved.id}`)
    .text("🗑️ Löschen", `photo:del:${saved.id}`);

  await ctx.replyWithPhoto(fileId, {
    caption: saved.isPrimary ? "Primärbild gespeichert ✅" : "Foto gespeichert ✅",
    reply_markup: kb,
  });
});

bot.callbackQuery(/^photo:set:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const photoId = Number(ctx.match![1]);
  const id = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return;

  const target = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!target || target.profileId !== prof.id) return;

  await prisma.photo.updateMany({ where: { profileId: prof.id }, data: { isPrimary: false } });
  await prisma.photo.update({ where: { id: photoId }, data: { isPrimary: true } });
  await ctx.editMessageCaption({ caption: "Primärbild ✅" });
});

bot.callbackQuery(/^photo:del:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const photoId = Number(ctx.match![1]);
  const id = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return;

  const target = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!target || target.profileId !== prof.id) return;

  const wasPrimary = target.isPrimary;
  await prisma.photo.delete({ where: { id: photoId } });

  if (wasPrimary) {
    const next = await prisma.photo.findFirst({
      where: { profileId: prof.id },
      orderBy: { createdAt: "desc" },
    });
    if (next) {
      await prisma.photo.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  }

  await ctx.editMessageCaption({ caption: "Foto gelöscht 🗑️" }).catch(() => {});
});

/**
 * ---------------------------
 *  /tags – Schnellbuttons + Freitext
 * ---------------------------
 */
async function showTags(ctx: MyContext) {
  const uid = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({
    where: { userId: uid },
    include: { profileTags: { include: { tag: true } } },
  });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const my = new Set(prof.profileTags.map((pt) => slugify(pt.tag.slug || pt.tag.label)));
  const list = prof.profileTags.map((pt) => `#${pt.tag.label.replace(/\s+/g, "")}`).join(" ");

  const kb = new InlineKeyboard();
  QUICK_TAGS.forEach((t, i) => {
    const on = my.has(slugify(t));
    kb.text(`${on ? "✅" : "☐"} ${t}`, `tag:q:${enc(t)}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  kb.row()
    .text("➕ Freitext", "tag:add")
    .text("🧹 Alle löschen", "tag:clear")
    .row()
    .text("✅ Fertig", "tag:done");

  await ctx.reply(
    `🏷️ *Deine Tags* (${my.size}/${MAX_TAGS_PER_PROFILE})\n${list || "— noch keine —"}\n\n` +
    `• Tippe auf Buttons zum An-/Abwählen.\n` +
    `• „➕ Freitext“: z. B. _„Metal, Berlin, Tanzen“_.`,
    { parse_mode: "Markdown", reply_markup: kb }
  );
}

bot.callbackQuery(/^tag:q:(.+)$/, async (ctx) => {
  const label = dec(ctx.match![1]);
  const slug = slugify(label);
  const uid = userIdOf(ctx);

  const prof = await prisma.profile.findUnique({
    where: { userId: uid },
    include: { profileTags: { include: { tag: true } } },
  });
  if (!prof) return ctx.answerCallbackQuery("Kein Profil");

  // Limit prüfen
  const mySlugs = new Set(prof.profileTags.map((pt) => pt.tag.slug));
  const has = mySlugs.has(slug);

  if (!has && mySlugs.size >= MAX_TAGS_PER_PROFILE) {
    return ctx.answerCallbackQuery("Max. 10 Tags erreicht.");
  }

  // Tag upsert
  const t = await prisma.tag.upsert({
    where: { slug },
    update: { label },
    create: { label, slug },
  });

  if (has) {
    await prisma.profileTag.delete({ where: { profileId_tagId: { profileId: prof.id, tagId: t.id } } });
    await ctx.answerCallbackQuery("Tag entfernt");
  } else {
    await prisma.profileTag.create({ data: { profileId: prof.id, tagId: t.id } });
    await ctx.answerCallbackQuery("Tag hinzugefügt");
  }

  // UI minimal aktualisieren: Keine Caption vorhanden → einfach Buttons neu schicken via showTags
  await showTags(ctx as MyContext);
});

bot.callbackQuery("tag:add", async (ctx) => {
  (ctx as MyContext).session.step = "tagsAdd";
  await ctx.answerCallbackQuery();
  await ctx.reply("Sende mir neue Tags als Text, getrennt durch Kommas. Beispiel: _Metal, Berlin, Tanzen_", {
    parse_mode: "Markdown",
  });
});

bot.callbackQuery("tag:clear", async (ctx) => {
  const uid = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: uid } });
  if (!prof) return ctx.answerCallbackQuery();

  await prisma.profileTag.deleteMany({ where: { profileId: prof.id } });
  await ctx.answerCallbackQuery("Alle Tags entfernt");
  await showTags(ctx as MyContext);
});

bot.callbackQuery("tag:done", async (ctx) => {
  await ctx.answerCallbackQuery("Fertig");
  await showMyProfile(ctx as MyContext);
});

// Freitext-Tags parsen
function parseTags(raw: string): string[] {
  return raw
    .split(/[,\n;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^#+/, ""))         // #tag → tag
    .map((x) => x.replace(/\s{2,}/g, " "))    // Mehrfachspaces
    .slice(0, 20);
}

async function addFreeTags(uid: bigint, labels: string[]) {
  const prof = await prisma.profile.findUnique({
    where: { userId: uid },
    include: { profileTags: { include: { tag: true } } },
  });
  if (!prof) return { added: 0, skipped: labels.length };

  const current = new Set(prof.profileTags.map((pt) => pt.tag.slug));
  let left = MAX_TAGS_PER_PROFILE - current.size;
  let added = 0;

  for (const labelRaw of labels) {
    if (left <= 0) break;
    const label = labelRaw.slice(0, 30);
    const slug = slugify(label);
    if (!slug || current.has(slug)) continue;

    const t = await prisma.tag.upsert({
      where: { slug },
      update: { label },
      create: { label, slug },
    });
    await prisma.profileTag.create({ data: { profileId: prof.id, tagId: t.id } });
    current.add(slug);
    left--;
    added++;
  }
  return { added, skipped: labels.length - added };
}

/**
 * ---------------------------
 *  /browse (Like / Skip / Report) – mit Tag-Ranking
 * ---------------------------
 */
async function startBrowse(ctx: MyContext) {
  const myId = userIdOf(ctx);
  const me = await prisma.profile.findUnique({
    where: { userId: myId },
    include: {
      audiences: true,
      profileTags: { include: { tag: true } },
    },
  });
  if (!me || !me.displayName || !me.age || !me.identity || me.audiences.length === 0) {
    return ctx.reply(
      "Dein Profil ist noch unvollständig. Bitte zuerst /profile ausfüllen (Name, Alter, Identität, Wen du suchst)."
    );
  }

  const queue = await buildCandidateQueue(myId, me);
  ctx.session.browse = { queue, index: 0, currentProfileId: undefined };

  if (queue.length === 0) {
    return ctx.reply("Keine passenden Profile gefunden. Versuch es später erneut.");
  }
  await showNextCandidate(ctx);
}

async function buildCandidateQueue(myId: bigint, me: any): Promise<number[]> {
  const myLikes = await prisma.like.findMany({ where: { fromUserId: myId } });
  const liked = new Set(myLikes.map((l) => l.toUserId.toString()));
  const myReports = await prisma.report.findMany({ where: { reporterUserId: myId } });
  const reported = new Set(myReports.map((r) => r.reportedUserId.toString()));

  const myIdentity = me.identity as Identity;
  const myLooking: Audience[] = me.audiences
    .map((a: any) => a.audience as Audience)
    .filter((a: string): a is Audience => (AUDIENCES as readonly string[]).includes(a));

  const prefs = await prisma.preferences.findUnique({ where: { userId: myId } });
  const minAge = prefs?.minAge ?? (me.isAdult ? 18 : 13);
  const maxAge = prefs?.maxAge ?? 120;

  const candidates = await prisma.profile.findMany({
    where: {
      userId: { not: myId },
      visible: true,
      displayName: { not: null },
      age: { gte: minAge, lte: maxAge },
      identity: { not: null },
    },
    include: {
      audiences: true,
      user: true,
      profileTags: { include: { tag: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 80,
  });

  const myTagSlugs = new Set<string>(me.profileTags.map((pt: any) => pt.tag.slug));

  const score = (cand: any) => {
    // Basis-Passung
    const cIdentity = cand.identity as Identity;
    if (!(IDENTITIES as readonly string[]).includes(cIdentity)) return -1;
    const catOfCand = identityToAudience(cIdentity);

    const iWantThem = myLooking.includes("ANY") || myLooking.includes(catOfCand);

    const theirLooking: Audience[] = cand.audiences
      .map((a: any) => a.audience as Audience)
      .filter((a: string): a is Audience => (AUDIENCES as readonly string[]).includes(a));
    const theyWantMe =
      theirLooking.includes("ANY") ||
      theirLooking.includes(identityToAudience(myIdentity));

    if (!iWantThem || !theyWantMe) return -1;
    if (liked.has(cand.userId.toString()) || reported.has(cand.userId.toString())) return -1;

    // Tag-Overlap
    const cSlugs: string[] = cand.profileTags.map((pt: any) => pt.tag.slug);
    let overlap = 0;
    for (const s of cSlugs) if (myTagSlugs.has(s)) overlap++;

    // Score: Overlap * 10 + Aktualität-Bonus (optional)
    return overlap * 10;
  };

  // sortiere nach Score (desc), dann updatedAt (desc)
  const ranked = candidates
    .map((c) => ({ c, s: score(c) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => (b.s - a.s) || (new Date(b.c.updatedAt).getTime() - new Date(a.c.updatedAt).getTime()))
    .map(({ c }) => c.id);

  return ranked;
}

async function showNextCandidate(ctx: MyContext) {
  const state = ctx.session.browse!;
  if (!state || state.index >= state.queue.length) {
    ctx.session.browse = undefined;
    return ctx.reply("🎉 Das war's für jetzt — keine weiteren Profile. Versuch es später erneut.");
  }

  const profileId = state.queue[state.index];
  const prof = await prisma.profile.findUnique({
    where: { id: profileId },
    include: {
      audiences: true,
      user: true,
      profileTags: { include: { tag: true } },
    },
  });
  if (!prof) {
    state.index++;
    return showNextCandidate(ctx);
  }

  state.currentProfileId = prof.id;

  const card = formatProfileCard(prof);
  const kb = new InlineKeyboard()
    .text("❤️ Like", "br_like")
    .text("⏭ Weiter", "br_skip")
    .row()
    .text("🚩 Melden", "br_report");

  const primary = await prisma.photo.findFirst({
    where: { profileId: prof.id, isPrimary: true },
  });
  if (primary) {
    await ctx.replyWithPhoto(primary.fileId, { caption: card, reply_markup: kb });
  } else {
    await ctx.reply(card, { reply_markup: kb });
  }
}

bot.callbackQuery("br_skip", async (ctx) => {
  const limit = checkRate(userIdOf(ctx), "skip", 120, 60 * 60 * 1000);
  if (!limit.ok) return ctx.answerCallbackQuery(`Zu viele Aktionen. Warte ~${limit.minutesLeft} Min.`);
  await ctx.answerCallbackQuery("Weiter");
  if (!ctx.session.browse) return ctx.reply("Nutze /browse zum Starten.");
  ctx.session.browse.index++;
  await showNextCandidate(ctx as MyContext);
});

bot.callbackQuery("br_like", async (ctx) => {
  const limit = checkRate(userIdOf(ctx), "like", 60, 60 * 60 * 1000);
  if (!limit.ok) return ctx.answerCallbackQuery(`Rate-Limit erreicht. Versuche es in ~${limit.minutesLeft} Min.`);
  await ctx.answerCallbackQuery("Gelikt ❤️");
  if (!ctx.session.browse?.currentProfileId) return ctx.reply("Nutze /browse zum Starten.");

  const myId = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({
    where: { id: ctx.session.browse.currentProfileId },
    include: { user: true },
  });
  if (!prof) {
    ctx.session.browse.index++;
    return showNextCandidate(ctx as MyContext);
  }

  await prisma.like.upsert({
    where: {
      fromUserId_toUserId: { fromUserId: myId, toUserId: prof.userId },
    },
    update: {},
    create: { fromUserId: myId, toUserId: prof.userId },
  });

  const match = await prisma.like.findFirst({
    where: { fromUserId: prof.userId, toUserId: myId },
  });

  if (match) {
    await ctx.reply(
      `🎉 *It's a match!* Mit ${prof.displayName}.\nChat: ${usernameOrLink(prof.user)}`,
      { parse_mode: "Markdown" }
    );
    try {
      await ctx.api.sendMessage(
        Number(prof.userId),
        `🎉 *It's a match!* Mit ${ctx.from?.first_name ?? "jemandem"}.\nChat: @${ctx.from?.username ?? ""}`.trim(),
        { parse_mode: "Markdown" }
      );
    } catch {}
  } else {
    await ctx.reply("Gespeichert. Wir sagen dir Bescheid, wenn es ein Match gibt. ✅");
  }

  ctx.session.browse.index++;
  await showNextCandidate(ctx as MyContext);
});

const REPORT_REASONS = [
  ["spam", "Spam/Scam"],
  ["harass", "Belästigung"],
  ["nsfw", "18+/NSFW unpassend"],
  ["fake", "Fake-Profil"],
  ["other", "Sonstiges"],
] as const;

bot.callbackQuery("br_report", async (ctx) => {
  const limit = checkRate(userIdOf(ctx), "report", 20, 60 * 60 * 1000);
  if (!limit.ok) return ctx.answerCallbackQuery(`Zu viele Meldungen. Warte ~${limit.minutesLeft} Min.`);
  if (!ctx.session.browse?.currentProfileId) return ctx.answerCallbackQuery();
  const kb = new InlineKeyboard();
  REPORT_REASONS.forEach(([code, label], i) => {
    kb.text(label, `rep:${code}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  kb.row().text("↩️ Abbrechen", "rep:cancel");
  await ctx.editMessageReplyMarkup({ reply_markup: kb });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^rep:(.+)$/, async (ctx) => {
  const code = ctx.match![1];
  if (code === "cancel") {
    const kb = new InlineKeyboard()
      .text("❤️ Like", "br_like")
      .text("⏭ Weiter", "br_skip")
      .row()
      .text("🚩 Melden", "br_report");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    return ctx.answerCallbackQuery("Abgebrochen");
  }

  if (!ctx.session.browse?.currentProfileId) return ctx.answerCallbackQuery();

  const prof = await prisma.profile.findUnique({
    where: { id: ctx.session.browse.currentProfileId },
  });
  if (!prof) return ctx.answerCallbackQuery();

  const myId = userIdOf(ctx);
  const label = REPORT_REASONS.find(([c]) => c === code)?.[1] ?? "Sonstiges";
  await prisma.report.create({
    data: { reporterUserId: myId, reportedUserId: prof.userId, reason: label },
  });

  await ctx.answerCallbackQuery("Gemeldet. Danke!");
  ctx.session.browse.index++;
  await showNextCandidate(ctx as MyContext);
});

/**
 * ---------------------------
 *  Text-Handler (Wizard + Tag-Freitext)
 * ---------------------------
 */
bot.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;

  if (step === "tagsAdd") {
    const uid = userIdOf(ctx);
    const tags = parseTags(ctx.message.text);
    const { added, skipped } = await addFreeTags(uid, tags);
    ctx.session.step = "idle";
    await ctx.reply(`Hinzugefügt: ${added}${skipped ? ` · Übersprungen: ${skipped}` : ""}`);
    return showTags(ctx as MyContext);
  }

  if (step === "idle") return next();

  const text = ctx.message.text.trim();

  if (step === "displayName") {
    ctx.session.temp.displayName = text.slice(0, 40);
    return goNext(ctx);
  }

  if (step === "age") {
    const age = Number(text);
    if (!Number.isInteger(age) || age < 13 || age > 120) {
      return ctx.reply("Bitte eine gültige Zahl 13–120 eingeben. (/cancel zum Abbrechen)");
    }
    ctx.session.temp.age = age;
    return goNext(ctx);
  }

  if (step === "bioSeek") {
    ctx.session.temp.bioSeek = text.slice(0, 500);
    return goNext(ctx);
  }

  return next();
});

/**
 * ---------------------------
 *  Wizard Callback-Handler (unverändert)
 * ---------------------------
 */
bot.callbackQuery(/^ident:(.+)$/, async (ctx) => {
  const raw = ctx.match![1];
  if (!(IDENTITIES as readonly string[]).includes(raw)) {
    return ctx.answerCallbackQuery("Ungültige Auswahl");
  }
  (ctx.session.temp.identity as Identity | undefined) = raw as Identity;
  ctx.session.step = "looking";
  await ctx.editMessageText("Wen suchst du? (Mehrfachauswahl möglich)");
  await ctx.reply("Wähle beliebig aus, dann „✅ Weiter“.", {
    reply_markup: kbLooking(ctx.session.temp.looking ?? []),
  });
});

bot.callbackQuery("back:identity", async (ctx) => goBack(ctx));

bot.callbackQuery(/^look:(.+)$/, async (ctx) => {
  const raw = ctx.match![1];
  if (!(AUDIENCES as readonly string[]).includes(raw)) {
    return ctx.answerCallbackQuery("Ungültig");
  }
  const arr = new Set(ctx.session.temp.looking ?? []);
  arr.has(raw as Audience) ? arr.delete(raw as Audience) : arr.add(raw as Audience);
  ctx.session.temp.looking = Array.from(arr);
  await ctx.editMessageReplyMarkup({
    reply_markup: kbLooking(ctx.session.temp.looking),
  });
  await ctx.answerCallbackQuery("Aktualisiert");
});

bot.callbackQuery("back:looking", async (ctx) => goBack(ctx));
bot.callbackQuery("next:looking", async (ctx) => {
  if (!ctx.session.temp.looking || ctx.session.temp.looking.length === 0) {
    return ctx.answerCallbackQuery("Bitte wähle mindestens eine Option.");
  }
  ctx.session.step = "bioSeek";
  await ctx.editMessageText("Weiter mit Freitext.");
  await ctx.reply(
    "Optional: *Was suchst du genau?* (kurzer Freitext, max. 500 Zeichen)",
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery("confirm:back", async (ctx) => goBack(ctx));
bot.callbackQuery("confirm:save", async (ctx) => {
  const id = userIdOf(ctx);
  const p = ctx.session.temp;

  if (!isTempComplete(p)) {
    return ctx.answerCallbackQuery("Bitte zuerst alle Schritte ausfüllen.");
  }

  const prof = await prisma.profile.upsert({
    where: { userId: id },
    update: {
      displayName: p.displayName!,
      age: p.age!,
      isAdult: p.age! >= 18,
      identity: p.identity!,
      bioSeek: p.bioSeek ?? null,
      visible: true,
    },
    create: {
      userId: id,
      displayName: p.displayName!,
      age: p.age!,
      isAdult: p.age! >= 18,
      identity: p.identity!,
      bioSeek: p.bioSeek ?? null,
      visible: true,
    },
  });

  await prisma.profileAudience.deleteMany({ where: { profileId: prof.id } });
  await prisma.profileAudience.createMany({
    data: (p.looking ?? []).map((a) => ({ profileId: prof.id, audience: a })),
  });

  ctx.session.step = "idle";
  ctx.session.temp = {};

  await ctx.editMessageText("✅ Gespeichert! Du kannst jetzt /browse nutzen.");
});

/**
 * ---------------------------
 *  Settings & Deleteme – aus deiner Version
 * ---------------------------
 */
bot.command("settings", async (ctx) => {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.upsert({
    where: { userId: id },
    create: { userId: id, showAdult: false },
    update: {},
  });

  const minAge = pref.minAge ?? 18;
  const maxAge = pref.maxAge ?? 120;

  const kb = new InlineKeyboard()
    .text(pref.showAdult ? "🔞 18+ AN" : "🔞 18+ AUS", "toggle_adult")
    .row()
    .text("− Min", "age:min:dec")
    .text("+ Min", "age:min:inc")
    .text("− Max", "age:max:dec")
    .text("+ Max", "age:max:inc")
    .row()
    .text("🔁 Reset", "age:reset");

  await ctx.reply(
    `Einstellungen:\n• 18+: ${pref.showAdult ? "AN" : "AUS"}\n• Alter: ${minAge}–${maxAge}`,
    { reply_markup: kb }
  );
});
bot.callbackQuery("toggle_adult", async (ctx) => {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.findUnique({ where: { userId: id } });
  if (!pref) return ctx.answerCallbackQuery();
  const nextVal = !pref.showAdult;
  await prisma.preferences.update({ where: { userId: id }, data: { showAdult: nextVal } });
  await ctx.answerCallbackQuery(nextVal ? "18+ sichtbar." : "18+ ausgeblendet.");
});
async function updateAgePref(ctx: MyContext, which: "min" | "max", delta: number) {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.upsert({
    where: { userId: id },
    create: { userId: id, showAdult: false },
    update: {},
  });
  let minAge = pref.minAge ?? 18;
  let maxAge = pref.maxAge ?? 120;
  if (which === "min") minAge = Math.min(Math.max(13, minAge + delta), maxAge);
  if (which === "max") maxAge = Math.max(Math.min(120, maxAge + delta), minAge);
  await prisma.preferences.update({ where: { userId: id }, data: { minAge, maxAge } });
  await ctx.answerCallbackQuery(`Alter: ${minAge}–${maxAge}`);
}
bot.callbackQuery("age:min:dec", (ctx) => updateAgePref(ctx as MyContext, "min", -1));
bot.callbackQuery("age:min:inc", (ctx) => updateAgePref(ctx as MyContext, "min", +1));
bot.callbackQuery("age:max:dec", (ctx) => updateAgePref(ctx as MyContext, "max", -1));
bot.callbackQuery("age:max:inc", (ctx) => updateAgePref(ctx as MyContext, "max", +1));
bot.callbackQuery("age:reset", async (ctx) => {
  const id = userIdOf(ctx);
  await prisma.preferences.update({ where: { userId: id }, data: { minAge: null, maxAge: null } });
  await ctx.answerCallbackQuery("Alter zurückgesetzt (Standard).");
});

bot.command("deleteme", async (ctx) => {
  const kb = new InlineKeyboard().text("❌ Löschen bestätigen", "del:yes").text("Abbrechen", "del:no");
  await ctx.reply("⚠️ Das löscht *alle* deine Daten (Profil, Likes, Meldungen, Einstellungen). Sicher?", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});
bot.callbackQuery("del:no", async (ctx) => {
  await ctx.answerCallbackQuery("Abgebrochen");
  await ctx.editMessageText("Löschen abgebrochen.");
});
bot.callbackQuery("del:yes", async (ctx) => {
  const id = userIdOf(ctx);
  const profile = await prisma.profile.findUnique({ where: { userId: id } });

  await prisma.like.deleteMany({ where: { OR: [{ fromUserId: id }, { toUserId: id }] } });
  await prisma.report.deleteMany({ where: { OR: [{ reporterUserId: id }, { reportedUserId: id }] } });

  if (profile) {
    await prisma.photo.deleteMany({ where: { profileId: profile.id } });
    await prisma.profileTag.deleteMany({ where: { profileId: profile.id } });
    await prisma.profileAudience.deleteMany({ where: { profileId: profile.id } });
    await prisma.profile.delete({ where: { id: profile.id } });
  }

  await prisma.preferences.deleteMany({ where: { userId: id } });
  await prisma.user.delete({ where: { id } }).catch(() => {});

  await ctx.answerCallbackQuery("Gelöscht");
  await ctx.editMessageText("🗑️ Deine Daten wurden gelöscht. Du kannst jederzeit neu starten mit /profile.");
});

/**
 * ---------------------------
 *  Errors & Start
 * ---------------------------
 */
bot.catch((err) => console.error(err));

console.log("✅ Bot läuft im Long-Polling. Drück Strg+C zum Beenden.");
bot.start();
