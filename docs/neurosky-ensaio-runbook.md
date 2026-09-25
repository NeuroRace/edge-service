# Roteiro de ensaio — NeuroSky real no estande

Como ligar o NeuroSky (MindWave) ao edge-service e ensaiar o dia do evento **sem tocar em produção**. Complementa o [`banca-runbook.md`](banca-runbook.md), que cobre o estande **só com simuladores**. A banca de 28/08 nunca passou por um sensor real; este roteiro cobre esse trecho.

> **Regra do ensaio:** **não crie o `.env` da raiz.** Sem `API_URL`, o dispatcher fica desligado (`/health` → `dispatcher.enabled: false`) e as corridas ficam só na fila local. Uma corrida de teste já vazou para produção antes (ver `e2e-local-runbook.md`). Para testar até o banco, use o Supabase **local** (Parte 2 do `e2e-local-runbook.md`).

## 0. Como o NeuroSky entra na esteira

```
MindWave ─(Bluetooth/dongle)─▶ ThinkGear Connector (TGC)  ── escuta SÓ em 127.0.0.1:13854
                                   │
                  eeg_acquisition (acquisition_service.py) ── lê o TGC, emite eSense 1x/s
                                   │  Socket.IO
                                   ▼
             broker :3000 ─▶ Redis (dispatch:queue) ─▶ dispatcher (desligado no ensaio)
               ▲    │
   jogo ───────┘    └─▶ tela de operação http://<broker>:3000/
 (raceStarted / hasFinished {playerId: 1|2})
```

**O TGC só aceita conexão do próprio PC** (`127.0.0.1`). Por isso a **aquisição tem que rodar no mesmo PC do NeuroSky**, e é ela que manda os dados pela rede até o broker. Um container ou PC remoto não alcança a porta 13854 de outra máquina.

## 1. Escolha a montagem

| | **A — tudo num PC** | **B — NeuroSky em outro PC** |
|---|---|---|
| Quando usar | primeiro ensaio; estande com 1 PC | NeuroSky longe do PC do broker, ou 2 NeuroSkys |
| Aquisição do NeuroSky | container `acquisition-a` (perfil `live`), via `host.docker.internal` | Python direto no PC do NeuroSky |
| Jogador 2 | bot (`simulator-b` + `acquisition-b`, `SOURCE=bot`) | bot, ou um 2º PC com NeuroSky |

Trocar NeuroSky ↔ bot exige reiniciar containers. Escolher pela tela é a NEU-86, que ainda não existe.

## 2. Preparar o NeuroSky (qualquer montagem)

- [ ] ThinkGear Connector instalado e **aberto** (ícone na bandeja).
- [ ] MindWave com bateria, **ligado** e pareado: Bluetooth do Windows no MindWave Mobile, ou dongle USB no MindWave com dongle.
- [ ] Fone colocado: sensor na testa, acima da sobrancelha, e clipe no lóbulo da orelha, com pele limpa.
- [ ] **Sonda do TGC** no PC do NeuroSky. Salve como `sonda-tgc.py` e rode `py -3.11 sonda-tgc.py`. Ela lê por 8 s e mostra o estado:

```python
import json, socket, time
s = socket.create_connection(("127.0.0.1", 13854), timeout=5)
s.sendall(b'{"enableRawOutput": false, "format": "Json"}')
buf, fim = b"", time.time() + 8
while time.time() < fim:
    buf += s.recv(4096)
    *linhas, buf = buf.split(b"\r")
    for linha in filter(None, (l.strip() for l in linhas)):
        d = json.loads(linha)
        print(d.get("status"), d.get("poorSignalLevel"), d.get("eSense"))
```

| A sonda mostra | Significa | O que fazer |
|---|---|---|
| erro de conexão | TGC fechado | abrir o ThinkGear Connector |
| `scanning 200 None` | TGC aberto, **fone não encontrado** | ligar e parear o MindWave; conferir a porta COM ou o dongle |
| `None 200 {...}` ou valores altos | fone conectado, **sem contato** com a pele | ajustar sensor e clipe; limpar a pele |
| `None 0 {'attention': .., 'meditation': ..}` | ✅ sinal bom | seguir |

## 3. Subir o estande

### Montagem A — tudo num PC
```bash
cd edge-service
docker compose --profile live config | grep API_URL      # tem que sair vazio
docker compose --profile live up -d --build
curl -s localhost:3000/health                            # status ok, dispatcher.enabled false
```
O `acquisition-a` lê o TGC do host. Confira com `docker compose --profile live logs -f acquisition-a`: o log `packet_received` precisa trazer `eSense`.

### Montagem B — NeuroSky em outro PC
**PC do broker:**
```bash
cd edge-service
docker compose --profile live up -d redis broker simulator-b acquisition-b   # sem acquisition-a
# 2 NeuroSkys reais: docker compose up -d redis broker
```
Libere a porta 3000 no firewall (PowerShell como administrador):
```powershell
New-NetFirewallRule -DisplayName "NeuroRace broker" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
ipconfig    # anote o IPv4 da rede do estande (prefira cabo; Wi-Fi de evento costuma isolar clientes)
```

**PC do NeuroSky** (Python 3.11 + cópia do repo ou só da pasta `eeg_acquisition/`):
```powershell
py -3.11 -m pip install "python-socketio[client]"
curl.exe http://<IP-DO-BROKER>:3000/health        # tem que responder {"status":"ok",...}
cd edge-service\eeg_acquisition
$env:PLAYER_ID="1"; $env:SOURCE="real"; $env:EEG_HOST="127.0.0.1"; $env:ACQ_PORT="13854"
$env:BROKER_URL="http://<IP-DO-BROKER>:3000"
py -3.11 acquisition_service.py
```
Para um segundo NeuroSky, em outro PC, use `PLAYER_ID="2"`.

## 4. Ensaio — cada etapa com o critério de passar

Abra **http://\<broker\>:3000/** (tela de operação). Onde a etapa diz "jogo", use o jogo real (NEU-90) ou o **jogo falso**, que só dá largada e chegada, sem inventar EEG:
```bash
cd edge-service/data_broker && npm ci      # 1ª vez
node e2e/jogo-falso.js http://<broker>:3000 60 1,2
```
Não use o `race-producer.js` neste ensaio: ele emite telemetria falsa para os dois jogadores e mistura com o sinal real.

| # | Etapa | Passa se |
|---|---|---|
| E1 | Sinal ao vivo | Jogador 1 com bolinha **verde / conectado**; qualidade boa (`poorSignalLevel 0`) |
| E2 | Atenção reage | Pedir ao jogador para contar de 100 para trás, de 7 em 7 (foco), depois fechar os olhos e relaxar: a atenção sobe e desce de forma visível |
| E3 | Registro | E-mails de **teste** registrados → cartões **Registrado** |
| E4 | Corrida | Jogo dá a largada → **Correndo**; sinal continua vivo durante a corrida |
| E5 | Chegada | `hasFinished` → **Finalizada**. Com o dispatcher desligado, fica na fila, e isso é o esperado |
| E6 | Pacotes gravados | `docker compose exec redis redis-cli LINDEX dispatch:queue 0` → `packets` com **≈ 1 por segundo de corrida** para o jogador 1 |
| E7 | Duas corridas seguidas | Repetir E3→E6 com outra dupla. Nada trava entre corridas |

**Checagem que importa no E6:** o broker **aceita corrida com `packets: []`**. Em teste de 25/09, uma corrida com o fone desconectado entrou na fila com tempo de largada e chegada e zero pacotes. Com a nuvem ligada, isso vira resultado no ranking sem nenhum EEG. Se o E1 não estiver verde, **não dê a largada**.

## 5. Cenários de falha (fazer com a corrida em andamento)

| # | Provoque | Espere na tela | Se não acontecer |
|---|---|---|---|
| F1 | Tirar o fone da cabeça | qualidade cai de **boa** para **fraca** ou **sem** (poorSignalLevel alto) | anotar: o operador não vê contato ruim |
| F2 | Desligar o MindWave | depois de ~10 s: banner **"Leitor do jogador 1 sem sinal"** | anotar e checar o log `acquisition` |
| F3 | Religar o MindWave | sinal volta **sem reiniciar nada** (a aquisição reconecta com backoff de até 10 s) | reiniciar a aquisição e anotar |
| F4 | (B) Tirar o cabo de rede do PC do NeuroSky por 20 s | sem sinal → volta sozinho | anotar o tempo de volta |
| F5 | Fechar o ThinkGear Connector | sem sinal; ao reabrir, volta | anotar |
| F6 | Largada **sem** registrar e-mails | banner vermelho **"NÃO será salva"** | — (já coberto no `banca-runbook`) |
| F7 | `docker compose restart broker` no meio | tela reconecta; a corrida em curso **pode se perder** | anotar o comportamento real |

## 6. No dia (com a nuvem)
1. Crie o `.env` da raiz (`API_URL` + `EDGE_INGEST_TOKEN`) seguindo o `banca-runbook.md` §0.
2. Faça **uma** corrida de checagem com e-mail de apresentador e veja **Enviada ✓** e a corrida em `/ranking`.
3. Mantenha a regra: **sinal verde antes da largada**.

## 7. Encerrar o ensaio
```bash
docker compose exec redis redis-cli LRANGE dispatch:queue 0 -1   # confira: só corridas de teste
docker compose --profile live down -v                           # zera a fila de TESTE junto com o volume
```
Nunca use `down -v` num estande com corridas reais ainda na fila.

## Pendências conhecidas que afetam o ensaio
- **NEU-102 (LGPD)** vai mudar a tela de operação: aceite do termo antes do e-mail e menores sempre anônimos. Refazer as etapas E3 e F6 depois dela.
- **NEU-86:** a fonte NeuroSky ou bot é fixa ao subir o Docker.
- **NEU-92:** com a nuvem fora do ar, a fila trava por minutos por corrida.
- **CORS:** jogo que roda no navegador fora de `localhost:8080/5173/8000` precisa de `BROKER_ALLOWED_ORIGINS`, e essa variável **não está repassada no `docker-compose.yml`**.
- **Corrida sem pacotes é aceita** (ver E6). Candidata a issue.
