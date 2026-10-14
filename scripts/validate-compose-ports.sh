#!/usr/bin/env bash
# Valida que nenhuma porta do edge fica aberta para a rede do evento (NEU-138).
# - docker-compose.yml: toda porta publicada so no loopback (127.0.0.1 e ::1).
# - + docker-compose.central.yml: o broker tambem no IP do cabo (CENTRAL_IP, padrao 192.168.50.1), nada mais.
# - docker-compose.collector.yml: loopback e BROKER_URL apontando para CENTRAL_IP pelo cabo.
# Uso: scripts/validate-compose-ports.sh   (na raiz do repo; precisa de docker compose + python3)
set -euo pipefail
cd "$(dirname "$0")/.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
unset CENTRAL_IP
cfg() { local out="$1"; shift; docker compose "$@" --profile '*' config --format json > "$tmp/$out"; }
cfg base.json -f docker-compose.yml
cfg central.json -f docker-compose.yml -f docker-compose.central.yml
CENTRAL_IP=10.0.0.9 cfg central-custom.json -f docker-compose.yml -f docker-compose.central.yml
cfg collector.json -f docker-compose.collector.yml
CENTRAL_IP=10.0.0.9 cfg collector-custom.json -f docker-compose.collector.yml
python3 - "$tmp" <<'PY'
import json, os, sys
d = sys.argv[1]; fails = []
LOOP = {"127.0.0.1", "::1"}
def load(n): return json.load(open(os.path.join(d, n)))["services"]
def need(cond, msg):
    if not cond: fails.append(msg)
def binds(svc):
    return {(p.get("host_ip", ""), str(p.get("published")), int(p["target"])) for p in svc.get("ports", [])}
def only_loopback(services, label, allowed_extra=()):
    for name, svc in services.items():
        for ip, pub, tgt in binds(svc):
            ok = ip in LOOP or (name, ip, tgt) in allowed_extra
            need(ok, f"{label}: {name} publica {pub}->{tgt} em host_ip={ip or '(todas as redes)'} (esperado so loopback)")

base = load("base.json")
only_loopback(base, "docker-compose.yml")
need({("127.0.0.1", "3000", 3000), ("::1", "3000", 3000)} <= binds(base["broker"]),
     f"docker-compose.yml: broker = {sorted(binds(base['broker']))} (esperado 3000 em 127.0.0.1 e ::1; o jogo usa localhost, que no Windows resolve ::1 primeiro)")

for fname, cable in (("central.json", "192.168.50.1"), ("central-custom.json", "10.0.0.9")):
    s = load(fname)
    only_loopback(s, f"central ({fname})", allowed_extra={("broker", cable, 3000)})
    need({("127.0.0.1", "3000", 3000), ("::1", "3000", 3000), (cable, "3000", 3000)} <= binds(s["broker"]),
         f"central ({fname}): broker = {sorted(binds(s['broker']))} (esperado loopback + {cable}:3000)")

for fname, cable in (("collector.json", "192.168.50.1"), ("collector-custom.json", "10.0.0.9")):
    s = load(fname)
    only_loopback(s, f"coletor ({fname})")
    url = s["acquisition-b"].get("environment", {}).get("BROKER_URL")
    need(url == f"http://{cable}:3000", f"coletor ({fname}): acquisition-b BROKER_URL={url} (esperado http://{cable}:3000)")

if fails:
    print("FAIL validate-compose-ports:"); [print("  -", f) for f in fails]; sys.exit(1)
print("OK validate-compose-ports: portas so no loopback; broker do central tambem no cabo; coletor aponta para CENTRAL_IP")
PY
