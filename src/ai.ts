// src/ai.ts
export async function aiComplete(
  prompt: string,
  system = "Du bist ein hilfreicher, inklusiver Dating-Assistent."
): Promise<string> {
  const url = process.env.AI_BASE_URL ?? "https://api.openai.com/v1/chat/completions";
  const model = process.env.AI_MODEL ?? "gpt-4o-mini";
  const key = process.env.AI_API_KEY;
  if (!key) return "⚠️ KI ist nicht konfiguriert. (Fehlender API-Key)";

  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt.slice(0, 1800) }
      ],
      temperature: 0.5
    })
  });

  const data = await res.json().catch(() => ({}));
  return data?.choices?.[0]?.message?.content?.trim()
      ?? "⚠️ Keine Antwort vom KI-Dienst.";
}

/** sehr leichte Auto-Moderation: erst Regex, dann optional KI */
export async function aiModerateText(text: string): Promise<{ flag?: boolean; reason?: string; nsfw?: boolean; harassment?: boolean; scam?: boolean }> {
  // 1) schnelle Keywords (anpassbar)
  const bad = /(sugar\s*daddy|whatsapp\s*nummer|onlyfans|escort|krypto|bitcoin|venmo|paypal)/i.test(text);
  if (bad) return { flag: true, reason: "verdächtige Keywords (Scam/Commercial)" };

  // 2) optional: KI-Auswertung
  if (!process.env.AI_API_KEY || process.env.AI_MODERATION_OFF === "1") return { flag: false };
  const jr = await aiComplete(
    `Bewerte folgenden Dating-Profiltext auf Richtlinienverstöße.
Text: """${text}"""
Antworte NUR kompaktes JSON:
{"nsfw":true|false,"harassment":true|false,"scam":true|false,"reason":"kurz"}`,
    "Du bist Moderations-Assistent. Antworte ausschließlich als minimales JSON ohne Zusatztext."
  );
  try { return JSON.parse(jr); } catch { return { flag: false }; }
}
