import "dotenv/config";
import {
  Bot,
  InlineKeyboard,
  Keyboard,
  session,
  Context,
  SessionFlavor,
} from "grammy";
import { Menu } from "@grammyjs/menu";
import { prisma } from "./db.js";

/**
 * --------------------------------
 *  Admin-Konfiguration
 * --------------------------------
 */
const ADMIN_IDS: bigint[] = (process.env.ADMIN_IDS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean)
  .map((x) => BigInt(x));

const isAdmin = (ctx: Context) => {
  const uid = BigInt(ctx.from!.id);
  return ADMIN_IDS.includes(uid);
};

/**
 * --------------------------------
 *  String-"Enums" (SQLite-safe)
 * --------------------------------
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
 * --------------------------------
 *  Tags (Quick-Buttons & Limits)
 * --------------------------------
 */
const QUICK_TAGS = [
  "Outdoor",
  "Reisen",
  "Wandern",
  "Fitness",
  "Kaffee",
  "Kochen",
  "Essen gehen",
  "Kino",
  "Musik",
  "Konzerte",
  "Gaming",
  "Fotografie",
  "Kunst",
  "Bücher",
  "Tiere",
  "Motorrad",
] as const;

const MAX_TAGS_PER_PROFILE = 10;

const slugify = (s: string) =>
  s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 30);

/**
 * --------------------------------
 *  Session / Wizard / Browse
 * --------------------------------
 */
type WizardStep =
  | "idle"
  | "displayName"
  | "age"
  | "identity"
  | "looking"
  | "bioSeek"
  | "confirm"
  | "tagsAdd"
  | "locText"
  | "adminSearch";

type TempProfile = {
  displayName?: string;
  age?: number;
  identity?: Identity;
  looking?: Audience[];
  bioSeek?: string;
};

type BrowseState = {
  queue: number[]; // Profile IDs
  index: number;
  currentProfileId?: number;
};

type SessionData = {
  step: WizardStep;
  temp: TempProfile;
  browse?: BrowseState;
};

type MyContext = Context & SessionFlavor<SessionData>;

/**
 * --------------------------------
 *  Utilities
 * --------------------------------
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
function checkRate(
  userId: bigint,
  action: string,
  limit: number,
  windowMs: number
) {
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
  const lookText =
    p.looking && p.looking.length
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
    case "MALE":
      return "MEN";
    case "FEMALE":
      return "WOMEN";
    case "TRANS_WOMAN":
      return "TRANS_WOMEN";
    case "TRANS_MAN":
      return "TRANS_MEN";
    case "NONBINARY":
      return "NONBINARY_PEOPLE";
    case "COUPLE":
      return "COUPLES";
    case "OTHER":
      return "ANY";
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
  const idLabel =
    p.identity && (IDENTITIES as readonly string[]).includes(p.identity as Identity)
      ? identityLabels[p.identity as Identity]
      : "—";
  const seeks =
    p.audiences
      .map((a) => a.audience)
      .filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a))
      .map((a) => audienceLabels[a])
      .join(", ") || "—";
  const age = p.age ?? "—";
  const bio = p.bioSeek?.trim() || "—";
  const tags =
    p.profileTags?.map((pt) => `#${pt.tag.label.replace(/\s+/g, "")}`) ?? [];
  const tagsLine = tags.length ? `\nTags: ${tags.slice(0, 6).join(" ")}` : "";
  return `${p.displayName}, ${age} · ${idLabel}\nSucht: ${seeks}\n„${bio}”${tagsLine}`;
};

const usernameOrLink = (u: { username: string | null; id: bigint }) => {
  if (u.username) return `@${u.username}`;
  return `tg://user?id=${u.id.toString()}`;
};

const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => decodeURIComponent(s);

/** Round coordinates for privacy */
const roundCoord = (x: number, decimals = 2) => {
  const m = Math.pow(10, decimals);
  return Math.round(x * m) / m;
};

/** Haversine distance in km */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371; // km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * --------------------------------
 *  Auto-Moderation (Wortfilter)
 * --------------------------------
 */
const MOD_BLOCKLIST = [
  /onlyfans/i,
  /\bsexarbeit\b/i,
  /\bpreise?\b/i,
  /\brates?\b/i,
  /\bwhatsapp\b/i,
  /\bwa\b[:\s]/i,
  /\bpaypal\b/i,
  /\bcashapp\b/i,
  /\busdt\b/i,
  /\bcrypto\b/i,
  /\bkik\b/i,
  /\bviber\b/i,
  /\bsnap(chat)?\b/i,
  /nudes?/i,
  /explicit/i,
  /\bpay\s?for\b/i,
];

function autoModerateText(...fields: (string | undefined | null)[]) {
  const bad: string[] = [];
  for (const f of fields) {
    const s = (f ?? "").toString();
    if (!s) continue;
    for (const rx of MOD_BLOCKLIST) {
      if (rx.test(s)) {
        bad.push(rx.source);
        break;
      }
    }
  }
  return { ok: bad.length === 0, bad };
}

/**
 * --------------------------------
 *  Bot Init + Middleware
 * --------------------------------
 */
const token = requireToken();
const bot = new Bot<MyContext>(token);

bot.use(
  session({
    initial: (): SessionData => ({ step: "idle", temp: {} }),
  })
);

/** Moderations-Gate: Gesperrte Nutzer blocken (Admins ausgenommen) */
bot.use(async (ctx, next) => {
  if (isAdmin(ctx)) return next();
  const uid = BigInt(ctx.from!.id);
  const prof = await prisma.profile.findUnique({ where: { userId: uid } });

  if (prof?.suspended) {
    const msg = ctx.message?.text ?? ctx.callbackQuery?.data ?? "";
    if (/^\/(start|help|deleteme)\b/.test(msg)) return next();
    return ctx.reply(
      "Dein Profil ist derzeit gesperrt. Kontaktiere einen Admin oder bearbeite dein Profil neutraler."
    );
  }
  return next();
});

/**
 * --------------------------------
 *  Hauptmenü
 * --------------------------------
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
  .text("📍 Standort", (ctx) => showLocation(ctx as MyContext))
  .row()
  .text("🔎 Entdecken", (ctx) => startBrowse(ctx));

bot.use(mainMenu);

/**
 * --------------------------------
 *  Onboarding Wizard
 * --------------------------------
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
    const auds = await prisma.profileAudience.findMany({
      where: { profileId: prof.id },
    });
    looking = auds
      .map((a) => a.audience as Audience)
      .filter(
        (a): a is Audience =>
          (AUDIENCES as readonly string[]).includes(a as Audience)
      );
  }

  ctx.session.temp = {
    displayName: prof?.displayName ?? undefined,
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
    return ctx.reply(
      "Schritt 1/6 — Gib bitte deinen *Anzeigenamen* ein (max 40 Zeichen).",
      { parse_mode: "Markdown" }
    );
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
 * --------------------------------
 *  Commands (User)
 * --------------------------------
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
    "Willkommen bei *QueerBeet Dating*! 🌈\n\n" +
      "• /profile – Profil einrichten/bearbeiten\n" +
      "• /myprofile – Profilkarte anzeigen\n" +
      "• /photos – Fotos verwalten (1–3)\n" +
      "• /tags – Interessen setzen\n" +
      "• /location – Standort setzen/verwalten\n" +
      "• /browse – Profile entdecken\n" +
      "• /settings – 18+, Alters- & Radius-Filter\n" +
      "• /deleteme – Profil & Daten löschen\n" +
      "• /cancel – aktuellen Vorgang abbrechen\n" +
      (isAdmin(ctx) ? "\n• /admin – Admin-Menü" : ""),
    { parse_mode: "Markdown", reply_markup: mainMenu }
  );
});

bot.command("profile", async (ctx) => startWizard(ctx));
bot.command("cancel", async (ctx) => {
  ctx.session.step = "idle";
  ctx.session.temp = {};
  await ctx.reply(
    "❌ Abgebrochen. Du kannst jederzeit mit /profile neu starten."
  );
});
bot.command("myprofile", async (ctx) => showMyProfile(ctx));
bot.command("browse", async (ctx) => startBrowse(ctx));
bot.command("photos", async (ctx) => showPhotos(ctx as MyContext));
bot.command("tags", async (ctx) => showTags(ctx as MyContext));
bot.command("location", async (ctx) => showLocation(ctx as MyContext));

/**
 * --------------------------------
 *  /myprofile
 * --------------------------------
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
  const locLine =
    prof.hasLocation && prof.lat != null && prof.lon != null
      ? `\n📍 Standort gesetzt${prof.city ? ` · ${prof.city}` : ""}`
      : prof.city
      ? `\n🏙️ ${prof.city}`
      : "";
  const statusLine =
    prof.suspended
      ? "\n⚠️ *Gesperrt*"
      : prof.shadowbanned
      ? "\n👻 Shadowbanned"
      : "";

  const kb = new InlineKeyboard()
    .text("✏️ Bearbeiten", "edit_profile")
    .text("🖼️ Fotos", "go_photos")
    .row()
    .text("🏷️ Tags", "go_tags")
    .text("📍 Standort", "go_location")
    .row()
    .text("🔎 Entdecken", "go_browse");

  await ctx.reply(card + locLine + statusLine, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
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
bot.callbackQuery("go_location", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showLocation(ctx as MyContext);
});

/**
 * --------------------------------
 *  Fotos (/photos)
 * --------------------------------
 */
async function showPhotos(ctx: MyContext) {
  const id = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const photos = await prisma.photo.findMany({
    where: { profileId: prof.id, removed: false },
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
  if (!limit.ok)
    return ctx.reply(
      `Zu viele Uploads. Bitte versuche es in ~${limit.minutesLeft} Min. erneut.`
    );

  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const count = await prisma.photo.count({
    where: { profileId: prof.id, removed: false },
  });
  if (count >= 3)
    return ctx.reply(
      "Du hast bereits 3 Fotos. Lösche zuerst eines mit 🗑️."
    );

  const sizes = ctx.message.photo;
  const largest = sizes[sizes.length - 1];
  const fileId = largest.file_id;

  const hasPrimary = await prisma.photo.findFirst({
    where: { profileId: prof.id, isPrimary: true, removed: false },
  });

  const saved = await prisma.photo.create({
    data: { profileId: prof.id, fileId, isPrimary: !hasPrimary },
  });

  const kb = new InlineKeyboard()
    .text(
      saved.isPrimary ? "⭐️ Primär" : "☆ Primär setzen",
      `photo:set:${saved.id}`
    )
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
  if (!target || target.profileId !== prof.id || target.removed) return;

  await prisma.photo.updateMany({
    where: { profileId: prof.id, removed: false },
    data: { isPrimary: false },
  });
  await prisma.photo.update({
    where: { id: photoId },
    data: { isPrimary: true },
  });
  await ctx.editMessageCaption({ caption: "Primärbild ✅" }).catch(() => {});
});

bot.callbackQuery(/^photo:del:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const photoId = Number(ctx.match![1]);
  const id = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: id } });
  if (!prof) return;

  const target = await prisma.photo.findUnique({ where: { id: photoId } });
  if (!target || target.profileId !== prof.id || target.removed) return;

  const wasPrimary = target.isPrimary;
  await prisma.photo.delete({ where: { id: photoId } });

  if (wasPrimary) {
    const next = await prisma.photo.findFirst({
      where: { profileId: prof.id, removed: false },
      orderBy: { createdAt: "desc" },
    });
    if (next) {
      await prisma.photo.update({
        where: { id: next.id },
        data: { isPrimary: true },
      });
    }
  }

  await ctx.editMessageCaption({ caption: "Foto gelöscht 🗑️" }).catch(() => {});
});

/**
 * --------------------------------
 *  Tags (/tags)
 * --------------------------------
 */
async function showTags(ctx: MyContext) {
  const uid = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({
    where: { userId: uid },
    include: { profileTags: { include: { tag: true } } },
  });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const my = new Set(
    prof.profileTags.map((pt) => slugify(pt.tag.slug || pt.tag.label))
  );
  const list = prof.profileTags
    .map((pt) => `#${pt.tag.label.replace(/\s+/g, "")}`)
    .join(" ");

  const kb = new InlineKeyboard();
  QUICK_TAGS.forEach((t, i) => {
    const on = my.has(slugify(t));
    kb.text(`${on ? "✅" : "☐"} ${t}`, `tag:q:${enc(t)}`);
    if ((i + 1) % 2 === 0) kb.row();
  });
  kb
    .row()
    .text("➕ Freitext", "tag:add")
    .text("🧹 Alle löschen", "tag:clear")
    .row()
    .text("✅ Fertig", "tag:done");

  await ctx.reply(
    `🏷️ *Deine Tags* (${my.size}/${MAX_TAGS_PER_PROFILE})\n${
      list || "— noch keine —"
    }\n\n` +
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

  const mySlugs = new Set(prof.profileTags.map((pt) => pt.tag.slug));
  const has = mySlugs.has(slug);

  if (!has && mySlugs.size >= MAX_TAGS_PER_PROFILE) {
    return ctx.answerCallbackQuery("Max. 10 Tags erreicht.");
  }

  const t = await prisma.tag.upsert({
    where: { slug },
    update: { label },
    create: { label, slug },
  });

  if (has) {
    await prisma.profileTag.delete({
      where: { profileId_tagId: { profileId: prof.id, tagId: t.id } },
    });
    await ctx.answerCallbackQuery("Tag entfernt");
  } else {
    await prisma.profileTag.create({
      data: { profileId: prof.id, tagId: t.id },
    });
    await ctx.answerCallbackQuery("Tag hinzugefügt");
  }

  await showTags(ctx as MyContext);
});

bot.callbackQuery("tag:add", async (ctx) => {
  (ctx as MyContext).session.step = "tagsAdd";
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Sende neue Tags als Text, getrennt durch Kommas. Beispiel: _Metal, Berlin, Tanzen_",
    { parse_mode: "Markdown" }
  );
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

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\n;]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.replace(/^#+/, ""))
    .map((x) => x.replace(/\s{2,}/g, " "))
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

    // Auto-Moderation auf einzelne Labels
    if (!autoModerateText(label).ok) continue;

    const slug = slugify(label);
    if (!slug || current.has(slug)) continue;

    const t = await prisma.tag.upsert({
      where: { slug },
      update: { label },
      create: { label, slug },
    });
    await prisma.profileTag.create({
      data: { profileId: prof.id, tagId: t.id },
    });
    current.add(slug);
    left--;
    added++;
  }
  return { added, skipped: labels.length - added };
}

/**
 * --------------------------------
 *  /location – Standort setzen / löschen / manuell
 * --------------------------------
 */
async function showLocation(ctx: MyContext) {
  const uid = userIdOf(ctx);
  const prof = await prisma.profile.findUnique({ where: { userId: uid } });
  if (!prof) return ctx.reply("Bitte erst ein Profil anlegen: /profile");

  const has = prof.hasLocation && prof.lat != null && prof.lon != null;
  const status = has
    ? `📍 Standort aktiv (≈ ${prof.lat?.toFixed(2)}, ${prof.lon?.toFixed(2)})`
    : prof.city
    ? `🏙️ Stadt gespeichert: ${prof.city}`
    : "Kein Standort gesetzt.";

  const kb = new InlineKeyboard()
    .text("📍 Standort teilen", "loc:share")
    .text("⌨️ Koordinaten/Ort", "loc:text")
    .row()
    .text(has ? "🙈 Standort ausblenden" : "—", "loc:clear")
    .text("✅ Fertig", "loc:done");

  await ctx.reply(
    `*Standort*\n${status}\n\nDu kannst deinen Live-Standort teilen oder Koordinaten eingeben.\nPrivatsphäre: Wir runden auf ~2 Dezimalen (~1–2 km).`,
    {
      parse_mode: "Markdown",
      reply_markup: kb,
    }
  );
}

bot.callbackQuery("loc:share", async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new Keyboard().requestLocation("📍 Standort senden").resized().oneTime();
  await ctx.reply("Tippe unten auf „📍 Standort senden“ und bestätige die Freigabe.", {
    reply_markup: kb,
  });
});

bot.on("message:location", async (ctx) => {
  const uid = userIdOf(ctx);
  const p = ctx.message.location;
  if (!p) return;
  const lat = roundCoord(p.latitude, 2);
  const lon = roundCoord(p.longitude, 2);

  await prisma.profile.update({
    where: { userId: uid },
    data: { lat, lon, hasLocation: true },
  });

  await ctx.reply(`Standort gespeichert: ≈ ${lat}, ${lon}`, {
    reply_markup: { remove_keyboard: true },
  });
});

bot.callbackQuery("loc:text", async (ctx) => {
  (ctx as MyContext).session.step = "locText";
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Sende Koordinaten als `lat,lon` (z. B. `52.52,13.40`) *oder* einen Städtenamen (nur Anzeige, kein Distanzfilter).",
    { parse_mode: "Markdown" }
  );
});

bot.callbackQuery("loc:clear", async (ctx) => {
  await ctx.answerCallbackQuery();
  const uid = userIdOf(ctx);
  await prisma.profile.update({
    where: { userId: uid },
    data: { hasLocation: false, lat: null, lon: null },
  });
  await ctx.editMessageText("Standort ausgeblendet. (/location für Optionen)");
});

bot.callbackQuery("loc:done", async (ctx) => {
  await ctx.answerCallbackQuery("Fertig");
  await showMyProfile(ctx as MyContext);
});

/**
 * --------------------------------
 *  /browse (Like / Skip / Report) – mit Tag + Distanz + Moderation
 * --------------------------------
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
  if (
    !me ||
    !me.displayName ||
    !me.age ||
    !me.identity ||
    me.audiences.length === 0
  ) {
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
  const myReports = await prisma.report.findMany({
    where: { reporterUserId: myId },
  });
  const reported = new Set(myReports.map((r) => r.reportedUserId.toString()));

  const myIdentity = me.identity as Identity;
  const myLooking: Audience[] = me.audiences
    .map((a: any) => a.audience as Audience)
    .filter((a: string): a is Audience =>
      (AUDIENCES as readonly string[]).includes(a)
    );

  const prefs = await prisma.preferences.findUnique({ where: { userId: myId } });
  const minAge = prefs?.minAge ?? (me.isAdult ? 18 : 13);
  const maxAge = prefs?.maxAge ?? 120;
  const radius = prefs?.radiusKm ?? null;

  const candidates = await prisma.profile.findMany({
    where: {
      userId: { not: myId },
      visible: true,
      suspended: false,
      shadowbanned: false,
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
    take: 120,
  });

  const myTagSlugs = new Set<string>(me.profileTags.map((pt: any) => pt.tag.slug));
  const hasMyLoc =
    !!(me.hasLocation && typeof me.lat === "number" && typeof me.lon === "number");

  type Item = {
    id: number;
    overlap: number;
    distanceKm: number | null;
    updatedAt: Date;
    prof: any;
  };
  const items: Item[] = [];

  for (const cand of candidates) {
    const cIdentity = cand.identity as Identity;
    if (!(IDENTITIES as readonly string[]).includes(cIdentity)) continue;
    const catOfCand = identityToAudience(cIdentity);

    const iWantThem = myLooking.includes("ANY") || myLooking.includes(catOfCand);
    const theirLooking: Audience[] = cand.audiences
      .map((a: any) => a.audience as Audience)
      .filter((a: string): a is Audience =>
        (AUDIENCES as readonly string[]).includes(a)
      );
    const theyWantMe =
      theirLooking.includes("ANY") ||
      theirLooking.includes(identityToAudience(myIdentity));

    if (!iWantThem || !theyWantMe) continue;
    if (liked.has(cand.userId.toString()) || reported.has(cand.userId.toString()))
      continue;

    // Tag-Overlap
    const cSlugs: string[] = cand.profileTags.map((pt: any) => pt.tag.slug);
    let overlap = 0;
    for (const s of cSlugs) if (myTagSlugs.has(s)) overlap++;

    // Distanz (optional)
    let distanceKm: number | null = null;
    if (
      hasMyLoc &&
      cand.hasLocation &&
      typeof cand.lat === "number" &&
      typeof cand.lon === "number"
    ) {
      distanceKm = Math.round(haversineKm(me.lat, me.lon, cand.lat, cand.lon));
    }

    // Radius-Filter (nur wenn Nutzer Location + Radius hat)
    if (hasMyLoc && radius != null && distanceKm != null && distanceKm > radius)
      continue;

    items.push({
      id: cand.id,
      overlap,
      distanceKm,
      updatedAt: cand.updatedAt,
      prof: cand,
    });
  }

  // Sortierung: 1) Tag-Overlap desc  2) Distanz asc (wenn vorhanden)  3) Aktualität desc
  items.sort((a, b) => {
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    const da = a.distanceKm ?? Infinity;
    const db = b.distanceKm ?? Infinity;
    if (da !== db) return da - db;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return items.map((x) => x.id);
}

async function showNextCandidate(ctx: MyContext) {
  const state = ctx.session.browse!;
  if (!state || state.index >= state.queue.length) {
    ctx.session.browse = undefined;
    return ctx.reply(
      "🎉 Das war's für jetzt — keine weiteren Profile. Versuch es später erneut."
    );
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

  // Distanz für Anzeige (falls beide Opt-in)
  let distanceLine = "";
  const me = await prisma.profile.findUnique({
    where: { userId: userIdOf(ctx) },
  });
  if (
    me &&
    me.hasLocation &&
    prof.hasLocation &&
    typeof me.lat === "number" &&
    typeof me.lon === "number" &&
    typeof prof.lat === "number" &&
    typeof prof.lon === "number"
  ) {
    const d = Math.round(haversineKm(me.lat, me.lon, prof.lat, prof.lon));
    distanceLine = `\n📏 Entfernung: ≈ ${d} km`;
  }

  const card = formatProfileCard(prof) + distanceLine;

  const kb = new InlineKeyboard()
    .text("❤️ Like", "br_like")
    .text("⏭ Weiter", "br_skip")
    .row()
    .text("🚩 Melden", "br_report");

  const primary = await prisma.photo.findFirst({
    where: { profileId: prof.id, isPrimary: true, removed: false },
  });
  if (primary) {
    await ctx.replyWithPhoto(primary.fileId, { caption: card, reply_markup: kb });
  } else {
    await ctx.reply(card, { reply_markup: kb });
  }
}

bot.callbackQuery("br_skip", async (ctx) => {
  const limit = checkRate(userIdOf(ctx), "skip", 120, 60 * 60 * 1000);
  if (!limit.ok)
    return ctx.answerCallbackQuery(
      `Zu viele Aktionen. Warte ~${limit.minutesLeft} Min.`
    );
  await ctx.answerCallbackQuery("Weiter");
  if (!ctx.session.browse) return ctx.reply("Nutze /browse zum Starten.");
  ctx.session.browse.index++;
  await showNextCandidate(ctx as MyContext);
});

bot.callbackQuery("br_like", async (ctx) => {
  const limit = checkRate(userIdOf(ctx), "like", 60, 60 * 60 * 1000);
  if (!limit.ok)
    return ctx.answerCallbackQuery(
      `Rate-Limit erreicht. Versuche es in ~${limit.minutesLeft} Min.`
    );
  await ctx.answerCallbackQuery("Gelikt ❤️");
  if (!ctx.session.browse?.currentProfileId)
    return ctx.reply("Nutze /browse zum Starten.");

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
      `🎉 *It's a match!* Mit ${prof.displayName}.\nChat: ${usernameOrLink(
        prof.user
      )}`,
      { parse_mode: "Markdown" }
    );
    try {
      await ctx.api.sendMessage(
        Number(prof.userId),
        `🎉 *It's a match!* Mit ${
          ctx.from?.first_name ?? "jemandem"
        }.\nChat: @${ctx.from?.username ?? ""}`.trim(),
        { parse_mode: "Markdown" }
      );
    } catch {}
  } else {
    await ctx.reply(
      "Gespeichert. Wir sagen dir Bescheid, wenn es ein Match gibt. ✅"
    );
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
  if (!limit.ok)
    return ctx.answerCallbackQuery(
      `Zu viele Meldungen. Warte ~${limit.minutesLeft} Min.`
    );
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
  const label =
    REPORT_REASONS.find(([c]) => c === code)?.[1] ?? "Sonstiges";
  await prisma.report.create({
    data: { reporterUserId: myId, reportedUserId: prof.userId, reason: label },
  });

  await ctx.answerCallbackQuery("Gemeldet. Danke!");
  ctx.session.browse.index++;
  await showNextCandidate(ctx as MyContext);
});

/**
 * --------------------------------
 *  Text-Handler (Wizard + Tag-Freitext + Location-Freitext + Admin-Suche)
 * --------------------------------
 */
bot.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;

  if (step === "adminSearch") {
    ctx.session.step = "idle";
    if (!isAdmin(ctx)) return ctx.reply("Nur für Admins.");
    const raw = ctx.message.text.trim().replace(/^@/, "");
    const user = /^\d+$/.test(raw)
      ? await prisma.user.findUnique({ where: { id: BigInt(raw) } })
      : await prisma.user.findFirst({ where: { username: raw } });

    if (!user) return ctx.reply("Kein Nutzer gefunden.");
    const kb = new InlineKeyboard().text(
      "👤 Profil anzeigen",
      `adm:profile:${user.id}`
    );
    return ctx.reply(`Gefunden: @${user.username ?? user.id}`, {
      reply_markup: kb,
    });
  }

  if (step === "tagsAdd") {
    const uid = userIdOf(ctx);
    const tags = parseTags(ctx.message.text);
    const { added, skipped } = await addFreeTags(uid, tags);
    ctx.session.step = "idle";
    await ctx.reply(
      `Hinzugefügt: ${added}${skipped ? ` · Übersprungen: ${skipped}` : ""}`
    );
    return showTags(ctx as MyContext);
  }

  if (step === "locText") {
    const text = ctx.message.text.trim();

    // Koordinaten "lat,lon"?
    const m = text.match(
      /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/
    );
    if (m) {
      const lat = roundCoord(parseFloat(m[1]), 2);
      const lon = roundCoord(parseFloat(m[2]), 2);
      const uid = userIdOf(ctx);
      await prisma.profile.update({
        where: { userId: uid },
        data: { lat, lon, hasLocation: true },
      });
      ctx.session.step = "idle";
      await ctx.reply(`Standort gespeichert: ≈ ${lat}, ${lon}`);
      return;
    }

    // Sonst Stadtname als Anzeige (kein Distanzfilter)
    const uid = userIdOf(ctx);
    await prisma.profile.update({
      where: { userId: uid },
      data: { city: text },
    });
    ctx.session.step = "idle";
    await ctx.reply(
      `Stadt gespeichert: ${text}\n(Hinweis: Für Distanzmatching bitte GPS oder Koordinaten nutzen.)`
    );
    return;
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
      return ctx.reply(
        "Bitte eine gültige Zahl 13–120 eingeben. (/cancel zum Abbrechen)"
      );
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
 * --------------------------------
 *  Wizard Callback-Handler
 * --------------------------------
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
  arr.has(raw as Audience)
    ? arr.delete(raw as Audience)
    : arr.add(raw as Audience);
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

  // Auto-Moderation prüfen
  const check = autoModerateText(p.displayName, p.bioSeek);
  if (!check.ok) {
    return ctx.answerCallbackQuery(
      "Dein Text enthält unerlaubte Inhalte. Bitte formuliere neutraler."
    );
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
 * --------------------------------
 *  Settings: 18+ Toggle + Altersfilter + Radius
 * --------------------------------
 */
bot.command("settings", async (ctx) => {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.upsert({
    where: { userId: id },
    create: { userId: id, showAdult: false, radiusKm: 50 },
    update: {},
  });

  const prof = await prisma.profile.findUnique({ where: { userId: id } });

  const minAge = pref.minAge ?? 18;
  const maxAge = pref.maxAge ?? 120;
  const radius = pref.radiusKm ?? 50;
  const loc = prof?.hasLocation ? "AN" : "AUS";

  const kb = new InlineKeyboard()
    .text(pref.showAdult ? "🔞 18+ AN" : "🔞 18+ AUS", "toggle_adult")
    .row()
    .text("− Min", "age:min:dec")
    .text("+ Min", "age:min:inc")
    .text("− Max", "age:max:dec")
    .text("+ Max", "age:max:inc")
    .row()
    .text("− Radius", "rad:dec")
    .text("+ Radius", "rad:inc")
    .text("🔁 Radius reset", "rad:reset");

  await ctx.reply(
    `Einstellungen:\n` +
      `• 18+: ${pref.showAdult ? "AN" : "AUS"}\n` +
      `• Alter: ${minAge}–${maxAge}\n` +
      `• Standort: ${loc}\n` +
      `• Radius: ${radius} km`,
    { reply_markup: kb }
  );
});

bot.callbackQuery("toggle_adult", async (ctx) => {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.findUnique({ where: { userId: id } });
  if (!pref) return ctx.answerCallbackQuery();
  const nextVal = !pref.showAdult;
  await prisma.preferences.update({
    where: { userId: id },
    data: { showAdult: nextVal },
  });
  await ctx.answerCallbackQuery(nextVal ? "18+ sichtbar." : "18+ ausgeblendet.");
});

async function updateAgePref(ctx: MyContext, which: "min" | "max", delta: number) {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.upsert({
    where: { userId: id },
    create: { userId: id, showAdult: false, radiusKm: 50 },
    update: {},
  });
  let minAge = pref.minAge ?? 18;
  let maxAge = pref.maxAge ?? 120;

  if (which === "min") minAge = Math.min(Math.max(13, minAge + delta), maxAge);
  if (which === "max") maxAge = Math.max(Math.min(120, maxAge + delta), minAge);

  await prisma.preferences.update({
    where: { userId: id },
    data: { minAge, maxAge },
  });

  await ctx.answerCallbackQuery(`Alter: ${minAge}–${maxAge}`);
}

bot.callbackQuery("age:min:dec", (ctx) => updateAgePref(ctx as MyContext, "min", -1));
bot.callbackQuery("age:min:inc", (ctx) => updateAgePref(ctx as MyContext, "min", +1));
bot.callbackQuery("age:max:dec", (ctx) => updateAgePref(ctx as MyContext, "max", -1));
bot.callbackQuery("age:max:inc", (ctx) => updateAgePref(ctx as MyContext, "max", +1));

bot.callbackQuery("rad:dec", async (ctx) => {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.findUnique({ where: { userId: id } });
  if (!pref) return ctx.answerCallbackQuery();
  const cur = pref.radiusKm ?? 50;
  const next = Math.max(5, cur <= 50 ? cur - 5 : cur - 25);
  await prisma.preferences.update({
    where: { userId: id },
    data: { radiusKm: next },
  });
  await ctx.answerCallbackQuery(`Radius: ${next} km`);
});

bot.callbackQuery("rad:inc", async (ctx) => {
  const id = userIdOf(ctx);
  const pref = await prisma.preferences.findUnique({ where: { userId: id } });
  if (!pref) return ctx.answerCallbackQuery();
  const cur = pref.radiusKm ?? 50;
  const next = cur < 50 ? cur + 5 : Math.min(500, cur + 25);
  await prisma.preferences.update({
    where: { userId: id },
    data: { radiusKm: next },
  });
  await ctx.answerCallbackQuery(`Radius: ${next} km`);
});

bot.callbackQuery("rad:reset", async (ctx) => {
  const id = userIdOf(ctx);
  await prisma.preferences.update({
    where: { userId: id },
    data: { radiusKm: 50 },
  });
  await ctx.answerCallbackQuery("Radius: 50 km");
});

bot.callbackQuery("age:reset", async (ctx) => {
  const id = userIdOf(ctx);
  await prisma.preferences.update({
    where: { userId: id },
    data: { minAge: null, maxAge: null },
  });
  await ctx.answerCallbackQuery("Alter zurückgesetzt (Standard).");
});

/**
 * --------------------------------
 *  /deleteme (Daten löschen)
 * --------------------------------
 */
bot.command("deleteme", async (ctx) => {
  const kb = new InlineKeyboard()
    .text("❌ Löschen bestätigen", "del:yes")
    .text("Abbrechen", "del:no");
  await ctx.reply(
    "⚠️ Das löscht *alle* deine Daten (Profil, Likes, Meldungen, Einstellungen). Sicher?",
    { parse_mode: "Markdown", reply_markup: kb }
  );
});

bot.callbackQuery("del:no", async (ctx) => {
  await ctx.answerCallbackQuery("Abgebrochen");
  await ctx.editMessageText("Löschen abgebrochen.");
});

bot.callbackQuery("del:yes", async (ctx) => {
  const id = userIdOf(ctx);
  const profile = await prisma.profile.findUnique({ where: { userId: id } });

  await prisma.like.deleteMany({
    where: { OR: [{ fromUserId: id }, { toUserId: id }] },
  });
  await prisma.report.deleteMany({
    where: { OR: [{ reporterUserId: id }, { reportedUserId: id }] },
  });

  if (profile) {
    await prisma.photo.deleteMany({ where: { profileId: profile.id } });
    await prisma.profileTag.deleteMany({ where: { profileId: profile.id } });
    await prisma.profileAudience.deleteMany({
      where: { profileId: profile.id },
    });
    await prisma.profile.delete({ where: { id: profile.id } });
  }

  await prisma.preferences.deleteMany({ where: { userId: id } });
  await prisma.user.delete({ where: { id } }).catch(() => {});

  await ctx.answerCallbackQuery("Gelöscht");
  await ctx.editMessageText(
    "🗑️ Deine Daten wurden gelöscht. Du kannst jederzeit neu starten mit /profile."
  );
});

/**
 * --------------------------------
 *  Admin-Menü & Moderations-Aktionen
 * --------------------------------
 */
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("Nur für Admins.");
  const kb = new InlineKeyboard()
    .text("📣 Reports (neueste 10)", "adm:reports")
    .row()
    .text("🔍 Nutzer suchen", "adm:search")
    .row()
    .text("❎ Schließen", "adm:close");
  await ctx.reply("*Admin-Menü*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

bot.callbackQuery("adm:close", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery("Schließen");
  await ctx.editMessageText("Admin-Menü geschlossen.");
});

bot.callbackQuery("adm:reports", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const last = await prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { reporterUser: true, reportedUser: true },
  });
  if (last.length === 0) return ctx.editMessageText("Keine Reports vorhanden.");

  let out = "📣 *Neueste Reports*\n";
  for (const r of last) {
    out += `#${r.id} · ${r.createdAt
      .toISOString()
      .slice(0, 16)
      .replace("T", " ")}\n`;
    out += `Von: @${
      r.reporterUser.username ?? r.reporterUser.id
    } → Gegen: @${r.reportedUser.username ?? r.reportedUser.id}\n`;
    out += `Grund: ${r.reason ?? "—"}\n\n`;
  }
  const kb = new InlineKeyboard()
    .text("➡ Aktionen öffnen", "adm:reports:act")
    .row()
    .text("◀️ Zurück", "adm:back");
  await ctx.editMessageText(out, {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

bot.callbackQuery("adm:back", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text("📣 Reports (neueste 10)", "adm:reports")
    .row()
    .text("🔍 Nutzer suchen", "adm:search")
    .row()
    .text("❎ Schließen", "adm:close");
  await ctx.editMessageText("*Admin-Menü*", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });
});

bot.callbackQuery("adm:reports:act", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();

  const last = await prisma.report.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { reportedUser: true },
  });
  if (last.length === 0) return;

  let i = 0;
  for (const r of last) {
    const kb = new InlineKeyboard()
      .text("👤 Profil", `adm:profile:${r.reportedUserId}`)
      .text("🚫 Sperren", `adm:susp:${r.reportedUserId}`)
      .row()
      .text("👻 Shadowban", `adm:shadow:on:${r.reportedUserId}`)
      .text("✅ Unban", `adm:unsusp:${r.reportedUserId}`)
      .row()
      .text("🗑 Report löschen", `adm:repdel:${r.id}`);
    await ctx.reply(
      `Report #${r.id} → @${r.reportedUser.username ?? r.reportedUserId}\nGrund: ${
        r.reason ?? "—"
      }`,
      { reply_markup: kb }
    );
    if (++i >= 10) break;
  }
});

bot.callbackQuery(/^adm:profile:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  await ctx.answerCallbackQuery();
  const uid = BigInt(ctx.match![1]);

  const prof = await prisma.profile.findUnique({
    where: { userId: uid },
    include: {
      audiences: true,
      profileTags: { include: { tag: true } },
      photos: true,
      user: true,
    },
  });
  if (!prof) return ctx.reply("Kein Profil.");

  const card =
    `${prof.displayName ?? "—"}, ${prof.age ?? "—"}\n` +
    `Status: ${
      prof.suspended ? "🚫 gesperrt" : prof.shadowbanned ? "👻 shadowban" : "✅ aktiv"
    }`;

  await ctx.reply(card);

  for (const ph of prof.photos) {
    const kb = new InlineKeyboard()
      .text(ph.removed ? "❌ Entfernt" : "🗑 Entfernen", `adm:phdel:${ph.id}`)
      .text(ph.isPrimary ? "⭐️ Primär" : "☆", "noop");
    await ctx.replyWithPhoto(ph.fileId, { reply_markup: kb });
  }
});

async function logAction(
  ctx: Context,
  action: string,
  data: {
    targetUserId?: bigint;
    targetProfileId?: number;
    targetPhotoId?: number;
    reason?: string;
  }
) {
  const actorUserId = BigInt(ctx.from!.id);
  await prisma.modAction.create({ data: { actorUserId, action, ...data } });
}

bot.callbackQuery(/^adm:susp:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const uid = BigInt(ctx.match![1]);
  const prof = await prisma.profile.findUnique({ where: { userId: uid } });
  if (!prof) return ctx.answerCallbackQuery("Kein Profil");
  await prisma.profile.update({
    where: { id: prof.id },
    data: {
      suspended: true,
      suspendedAt: new Date(),
      suspendedByUserId: BigInt(ctx.from!.id),
    },
  });
  await logAction(ctx, "PROFILE_SUSPEND", {
    targetUserId: uid,
    targetProfileId: prof.id,
  });
  await ctx.answerCallbackQuery("Gesperrt 🚫");
});

bot.callbackQuery(/^adm:unsusp:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const uid = BigInt(ctx.match![1]);
  const prof = await prisma.profile.findUnique({ where: { userId: uid } });
  if (!prof) return ctx.answerCallbackQuery("Kein Profil");
  await prisma.profile.update({
    where: { id: prof.id },
    data: { suspended: false, suspendedReason: null },
  });
  await logAction(ctx, "PROFILE_UNSUSPEND", {
    targetUserId: uid,
    targetProfileId: prof.id,
  });
  await ctx.answerCallbackQuery("Entsperrt ✅");
});

bot.callbackQuery(/^adm:shadow:on:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const uid = BigInt(ctx.match![1]);
  const prof = await prisma.profile.findUnique({ where: { userId: uid } });
  if (!prof) return ctx.answerCallbackQuery("Kein Profil");
  await prisma.profile.update({
    where: { id: prof.id },
    data: { shadowbanned: true },
  });
  await logAction(ctx, "SHADOWBAN_ON", {
    targetUserId: uid,
    targetProfileId: prof.id,
  });
  await ctx.answerCallbackQuery("Shadowban aktiv 👻");
});

bot.callbackQuery(/^adm:repdel:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const id = Number(ctx.match![1]);
  await prisma.report.delete({ where: { id } }).catch(() => {});
  await logAction(ctx, "REPORT_DELETE", {});
  await ctx.answerCallbackQuery("Report gelöscht");
});

bot.callbackQuery(/^adm:phdel:(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCallbackQuery();
  const id = Number(ctx.match![1]);
  const ph = await prisma.photo.findUnique({ where: { id } });
  if (!ph) return ctx.answerCallbackQuery("Kein Foto");
  await prisma.photo.update({
    where: { id },
    data: {
      removed: true,
      removedAt: new Date(),
      removedByUserId: BigInt(ctx.from!.id),
    },
  });
  await logAction(ctx, "PHOTO_REMOVE", {
    targetPhotoId: id,
    targetProfileId: ph.profileId,
  });
  await ctx.answerCallbackQuery("Foto entfernt");
});

bot.callbackQuery("noop", async (ctx) => {
  await ctx.answerCallbackQuery();
});

/**
 * --------------------------------
 *  Errors & Start
 * --------------------------------
 */
bot.catch((err) => console.error(err));

console.log("✅ Bot läuft im Long-Polling. Drück Strg+C zum Beenden.");
bot.start();
