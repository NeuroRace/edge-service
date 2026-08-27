#!/usr/bin/env bash
# Valida mecanicamente o perfil `banca` do docker-compose.yml (banca/NEXT: 2 simuladores + 2 jogadores humanos).
# Uso: scripts/validate-compose-banca.sh   (na raiz do repo; precisa de docker compose + python3)
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f docker-compose.yml --profile banca config --format json > /tmp/compose-banca.$$.json
python3 - /tmp/compose-banca.$$.json <<'PY'
import json, sys
c = json.load(open(sys.argv[1])); s = c["services"]; fails = []
def need(cond, msg):
    if not cond: fails.append(msg)
EXPECTED = {"redis","broker","simulator-a","simulator-b","acquisition-a-sim","acquisition-b-sim","test-client"}  # test-client nao tem perfil (sempre presente)
need(set(s) == EXPECTED, f"servicos do perfil banca = {sorted(s)} (esperado exatamente {sorted(EXPECTED)}; extras={sorted(set(s)-EXPECTED)} faltando={sorted(EXPECTED-set(s))})")
for name, pid, host, port in (("acquisition-a-sim","1","simulator-a","13854"),("acquisition-b-sim","2","simulator-b","13855")):
    if name in s:
        env = s[name].get("environment", {}); dep = s[name].get("depends_on", {})
        need(str(env.get("PLAYER_ID")) == pid, f"{name}: PLAYER_ID={env.get('PLAYER_ID')} (esperado {pid})")
        need(env.get("EEG_HOST") == host, f"{name}: EEG_HOST={env.get('EEG_HOST')} (esperado {host})")
        need(str(env.get("ACQ_PORT")) == port, f"{name}: ACQ_PORT={env.get('ACQ_PORT')} (esperado {port})")
        need(env.get("SOURCE") == "real", f"{name}: SOURCE={env.get('SOURCE')} (esperado real)")
        need("broker" in dep and host in dep, f"{name}: depends_on={list(dep)} (esperado broker + {host})")
for name in ("simulator-a","simulator-b"):
    if name in s: need(s[name].get("restart") == "unless-stopped", f"{name}: restart={s[name].get('restart')} (esperado unless-stopped)")
if "broker" in s:
    env = s["broker"].get("environment", {})
    for k, d in (("DISPATCH_HTTP_TIMEOUT_MS","15000"),("DISPATCH_MAX_ATTEMPTS","8"),("DISPATCH_BACKOFF_MAX_MS","10000")):
        need(str(env.get(k)) == d, f"broker: {k}={env.get(k)} (esperado default {d} sem env)")
if fails:
    print("FAIL validate-compose-banca:"); [print("  -", f) for f in fails]; sys.exit(1)
print("OK validate-compose-banca: perfil banca = 2 simuladores + 2 jogadores humanos, restart nos simuladores, DISPATCH_* no broker")
PY
rm -f /tmp/compose-banca.$$.json
