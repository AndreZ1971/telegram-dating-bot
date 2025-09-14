# Telegram Dating Bot (MVP)

TypeScript + grammY + Prisma/SQLite. Mit 18+ Toggle (MVP) und erweiterbarer Struktur.

## Setup
1. Node.js >= 18, git
2. `cp .env.example .env` und `BOT_TOKEN` setzen
3. `npx prisma migrate dev --name init` (erstellt SQLite)
4. Entwicklung: `npm run dev`

## Scripts
- `npm run dev` – tsx watcher
- `npm run build` – TypeScript build nach `dist/`
- `npm start` – Start mit Node
