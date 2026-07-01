# WORK FLOW — Task Intelligence
Personal AI-powered task manager using **Groq AI (FREE — no billing needed)**.

## Quick Start
```bash
bash install.sh
```
Script will:
1. Check Node.js
2. Install packages
3. Ask for Groq API key → auto-saves to .env
4. Open VS Code
5. Start the app at localhost:3000

## Get Free Groq API Key
1. Go to https://console.groq.com/keys
2. Sign up / Log in (free)
3. Click "Create API Key"
4. Copy & paste when install.sh asks (starts with `gsk_...`)

## Deploying to Vercel
> ⚠️ `.env` is gitignored — your API key is NOT pushed to GitHub.
> You must manually add it in Vercel's dashboard.

1. Push your code to GitHub
2. Go to https://vercel.com → Import your repo
3. Framework: **Create React App** (auto-detected)
4. Go to **Settings → Environment Variables**
5. Add:
   - Key: `REACT_APP_GROQ_API_KEY`
   - Value: `gsk_your_key_here`
6. Click **Deploy** ✅

## Every update push
```bash
git add .
git commit -m "update: description"
git push
```
Vercel auto-deploys! ✅

## Features
- ✅ Task manager with priority (High / Medium / Low)
- ✅ Due date + due time per task
- ✅ Push notifications on mobile & desktop when timer fires
- ✅ AI assistant (Groq — llama-3.1-8b-instant)
- ✅ Reminders panel with upcoming tasks
- ✅ Stats dashboard
- ✅ LocalStorage persistence
- ✅ Responsive: desktop 2-col + mobile bottom nav
