#!/bin/bash
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  WORK FLOW — Task Intelligence  "
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Check Node
if ! command -v node &> /dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "✅ Node $(node -v) found"

# 2. Install packages
echo "📦 Installing packages..."
npm install

# 3. Ask for Groq API key
echo ""
echo "🔑 Enter your Groq API key (from https://console.groq.com/keys)"
echo "   Leave blank to skip (you can add it to .env later)"
read -p "   Groq API Key (gsk_...): " GROQ_KEY

if [ -n "$GROQ_KEY" ]; then
  echo "REACT_APP_GROQ_API_KEY=$GROQ_KEY" > .env
  echo "✅ Key saved to .env"
else
  echo "REACT_APP_GROQ_API_KEY=your_groq_key_here" > .env
  echo "⚠️  Skipped — edit .env later"
fi

# 4. Open VS Code if available
if command -v code &> /dev/null; then
  code .
fi

# 5. Start dev server
echo ""
echo "🚀 Starting at http://localhost:3000 ..."
npm start
