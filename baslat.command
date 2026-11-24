#!/bin/bash
# macOS: çift tıklayarak çalıştırın (ilk seferde sağ tık > Aç gerekebilir).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js bulunamadı. https://nodejs.org adresinden LTS sürümünü kurup tekrar deneyin."
  echo ""
  open "https://nodejs.org" 2>/dev/null || xdg-open "https://nodejs.org" 2>/dev/null
  read -r -p "Kapatmak için Enter'a basın…"
  exit 1
fi
exec node server.js --open --lan
