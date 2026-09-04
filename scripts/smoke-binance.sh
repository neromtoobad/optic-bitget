#!/usr/bin/env bash
# Smoke the Binance edition end to end against a base URL (default: the Railway service).
#   ./scripts/smoke-binance.sh https://optic-binance-production.up.railway.app
set -u
U="${1:-https://optic-binance-production.up.railway.app}"
post() { curl -s -m 300 -X POST "$U$1" -H 'content-type: application/json' -d "$2"; }
line() { python3 -c "import sys,json; v=json.load(sys.stdin); print(v.get('verdict_line') or v.get('error'))"; }
echo "health:   $(curl -s -m 15 "$U/v1/health")"
echo "status:   $(curl -s -m 15 "$U/v1/binance/status" | python3 -c "import sys,json; v=json.load(sys.stdin); print('authorized' if v['authorized'] else 'not authorised', 'tools', len(v['tools']))")"
echo "read BTC: $(post /v1/read '{"query":"BTC"}' | line)"
echo "read fed: $(post /v1/read '{"query":"fed rate cut in september"}' | line)"
echo "scan:     $(post /v1/read '{"query":"what is heating up"}' | line)"
echo "rug CAKE: $(post /v1/rug '{"query":"0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"}' | line)"
echo "timing:   $(post /v1/timing '{"query":"CAKE"}' | line)"
echo "smart $:  $(post /v1/smart-money '{}' | line)"
echo "daily:    $(post /v1/daily '{}' | line)"
echo "edge:     $(post /v1/edge '{}' | line)"
echo "stocks:   $(post /v1/stocks '{"query":"NVDA"}' | line)"
echo "pulse:    $(post /v1/pulse '{}' | line)"
echo "ticket:   $(post /v1/ticket '{"query":"Fed decision in September no change","side":"yes","usdt":25}' | line)"
