# Telegram Dating Bot (MVP)  

*Deutsch* · [English below](#english-below)

Ein flexibler, erweiterbarer **Telegram-Dating-Bot** auf Basis **TypeScript + grammY + Prisma (SQLite)**.  
Er ermöglicht eine **einfache Dating-/Friends-Plattform direkt in Telegram** – mit **Profilen**, **Fotos (später)**, **Match-Logik (später)** und **altersabhängigen Modi**:

- **Jugendfrei-Modus** (SFW): zum Finden von **Freundschaften / Community**  
- **18+-Modus** (NSFW-Filter): für **Flirts & Dating** mit klaren Regeln

> ⚠️ **Wichtig:** 18+ Inhalte sind **nur** für volljährige Nutzer. Keine Duldung von Minderjährigen in 18+ Bereichen, keine illegalen Inhalte. Einhaltung von Telegram-Richtlinien + lokalen Gesetzen ist Pflicht.

---

## ✨ Features (MVP)

- `/start` & Menü (grammY Menu)
- **Profil-Onboarding** via `/profile`: `displayName → age → bioMe → bioSeek`
- **Einstellungen** via `/settings`: einfacher **18+ Toggle**
- **Prisma + SQLite**: schnelle, portable DB
- **Lauffähig lokal** via Long-Polling; später **Webhook**/Serverbetrieb möglich

### Geplante Erweiterungen (Roadmap)

- **Browse / Swipe / Match** (wechselseitige Likes → Match)
- **Fotos** (Upload über Telegram Photo, Avatar/Primärbild)
- **Standort / Distanzfilter** (optional über Telegram Location)
- **Interessen/Tags & thematische „Communities“** (z. B. Gamer, LGBTQ+, Expats)
- **Mod-Tools**: Melden/Blockieren, Moderations-Queue
- **Content-Safety**: SFW/NSFW-Trennung; Auto-Checks (z. B. Bildklassifikation)
- **Admin-Panel** (Statistiken, Policies, Nutzerverwaltung)
- **Internationalisierung** (mehrsprachige UX)

---

## 🧱 Tech-Stack

- **Runtime:** Node.js (empfohlen LTS 20/22)
- **Bot:** [grammY](https://grammy.dev/)
- **DB/ORM:** Prisma + SQLite (MVP), später Postgres möglich
- **Sprache:** TypeScript

Projektstruktur (vereinfacht):
