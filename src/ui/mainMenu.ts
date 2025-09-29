import { InlineKeyboard } from "grammy";

export function buildMainMenu(isAdmin: boolean) {
  const kb = new InlineKeyboard()
    .text("🧭 Profil einrichten", "menu:profile").row()
    .text("👤 Meine Karte", "menu:myprofile").row()
    .text("🖼️ Fotos", "menu:photos").text("🏷️ Tags", "menu:tags").row()
    .text("📍 Standort", "menu:location").text("🔎 Entdecken", "menu:browse").row()
    .text("⚙️ Einstellungen", "menu:settings").text("🤖 KI-Hilfe", "menu:ai").row()
    .text("🗑️ Löschen", "menu:deleteme").text("❌ Abbrechen", "menu:cancel");

  if (isAdmin) kb.row().text("🛡️ Admin", "menu:admin");
  return kb; // ⬅️ wirklich zurückgeben!
}