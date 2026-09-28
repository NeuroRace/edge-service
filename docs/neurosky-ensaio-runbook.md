# Runbook — NeuroSky real no estande (2 PCs ligados por cabo)

Como ligar o NeuroSky (MindWave) e o jogo (Unreal) num PC, o painel do operador em outro, e fazer a corrida funcionar de ponta a ponta. **Validado em 25/09/2026**: NeuroSky + jogo no PC do Nikolas, broker + painel no PC do Breq, cabo de rede direto entre os dois. Complementa o [`banca-runbook.md`](banca-runbook.md), que cobre o estande **só com simuladores**.

> **Regra do ensaio:** **não crie o `.env` da raiz.** Sem `API_URL`, o dispatcher fica desligado (`/health` → `dispatcher.enabled: false`) e as corridas ficam só na fila local. Uma corrida de teste já vazou para produção antes (ver `e2e-local-runbook.md`). No dia do evento, siga a seção 8.

## 1. A montagem que funcionou

```
PC-JOGO (Nikolas) — 192.168.50.2                      PC-PAINEL (Breq) — 192.168.50.1
┌───────────────────────────────────────────┐  cabo   ┌──────────────────────────────────┐
│ MindWave ─BT─▶ ThinkGear Connector :13854 │  de     │ Docker: broker :3000 + Redis     │
│                 (só 127.0.0.1)            │  rede   │ painel: http://localhost:3000    │
│ aquisição (Python) ─┐                     │ ──────▶ │                                  │
│ jogo (Unreal) ──────┴─▶ localhost:3000 ───┼─portproxy─▶ 192.168.50.1:3000              │
└───────────────────────────────────────────┘         └──────────────────────────────────┘
```

Três fatos definem a montagem:
1. **O ThinkGear Connector (TGC) só aceita conexão do próprio PC** (`127.0.0.1:13854`). Por isso a **aquisição roda no PC do NeuroSky**. Um container ou outro PC não conseguem ler o fone.
2. **O jogo (Unreal) procura o broker em `localhost:3000`.** Na banca de 28/08, o broker rodava no mesmo PC do jogo. Em vez de mexer no jogo, o PC-JOGO **redireciona** `localhost:3000` para o PC-PAINEL (`portproxy`, seção 4). Confirmado em 25/09: com o redirecionamento, a largada do jogo chegou ao painel.
3. **O jogo e o painel só recebem a atenção pelo broker.** Se a aquisição não estiver rodando, a largada funciona (o painel vai para "Correndo"), mas o carro não anda e o painel fica sem sinal.

## 2. Material
- 2 PCs Windows e **1 cabo de rede** comum (placas atuais não precisam de cabo crossover).
- PC-PAINEL: Docker Desktop e o repo `edge-service`.
- PC-JOGO: ThinkGear Connector, Python 3.11, Git (ou a pasta `eeg_acquisition/`), o jogo e o MindWave com bateria.

> **Antes de começar, três armadilhas que custaram tempo no ensaio:**
> - **Rode cada comando no PC certo.** Todo bloco abaixo diz em qual PC ele vai. Rodar o IP do PC-JOGO no PC-PAINEL derruba o endereço do broker.
> - **Um comando por vez.** Colar dois comandos juntos na mesma linha gera "Sintaxe fornecida inválida".
> - **Prompt de Comando ≠ PowerShell.** Os comandos abaixo são para o **Prompt de Comando como administrador**. No PowerShell, `curl` é outro comando: use `curl.exe`. Se aparecer `>>`, o PowerShell está esperando o fim do comando: aperte `Ctrl+C` e digite de novo.

## 3. Rede: cabo direto e IPs fixos

**PC-PAINEL** (Prompt de Comando como administrador):
```
netsh interface ipv4 set address name="Ethernet" static 192.168.50.1 255.255.255.0
```
```
netsh advfirewall firewall add rule name="NeuroRace broker" dir=in action=allow protocol=TCP localport=3000
```
Tem que responder `Ok.`

**PC-JOGO:**
```
netsh interface ipv4 set address name="Ethernet" static 192.168.50.2 255.255.255.0
```

**Conferir nos dois:** `ipconfig`. O adaptador **Ethernet** tem que mostrar o IP certo (`.1` no painel, `.2` no jogo).

| `ipconfig` mostra | O que fazer |
|---|---|
| Ethernet **"mídia desconectada"** | o cabo não foi reconhecido: reencaixe até dar clique nas duas pontas, veja se a luz da porta acende e troque o cabo se precisar. Confira se o cabo liga **um PC ao outro**, e não à tomada da parede |
| erro de nome de interface | `netsh interface show interface` e troque `"Ethernet"` pelo nome da placa cabeada |
| `Ethernet 2` com `192.168.56.x` | adaptador virtual (VirtualBox). Ignore |

A internet continua pelo Wi-Fi. **Não use o Wi-Fi da FIAP para ligar os PCs**: no ensaio, cada PC caiu numa sub-rede diferente (`10.51.x` e `10.60.x`). Sem cabo, o plano B é o **Hotspot móvel** do Windows no PC-PAINEL (IP `192.168.137.1`).

## 4. PC-JOGO: redirecionar `localhost:3000` para o painel

1. A porta 3000 tem que estar livre no PC-JOGO:
   ```
   netstat -ano | findstr :3000
   ```
   Não pode haver linha `LISTENING`. Se houver, feche o Docker Desktop desse PC, porque um broker local roubaria a conexão do jogo.
2. Crie o redirecionamento (os dois comandos cobrem IPv4 e IPv6):
   ```
   netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=3000 connectaddress=192.168.50.1 connectport=3000
   ```
   ```
   netsh interface portproxy add v6tov4 listenaddress=::1 listenport=3000 connectaddress=192.168.50.1 connectport=3000
   ```
3. Teste, ainda no PC-JOGO:
   ```
   curl.exe http://localhost:3000/health
   ```
   Tem que responder `{"status":"ok","service":"broker",...}`. Essa resposta vem do PC-PAINEL, pelo cabo.

Para desfazer ao fim do dia (PC-JOGO):
```
netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=3000
```
```
netsh interface portproxy delete v6tov4 listenaddress=::1 listenport=3000
```

## 5. PC-PAINEL: subir o broker

```bash
cd edge-service
docker compose --profile live config | grep API_URL          # tem que sair vazio no ensaio
docker compose --profile live up -d redis broker simulator-b acquisition-b
curl -s localhost:3000/health                                # status ok
```
- Isso sobe o broker com o **jogador 2 como bot**. Para 2 NeuroSkys reais (um por PC-JOGO), use só `docker compose up -d redis broker`.
- **Não suba o `acquisition-a` no PC-PAINEL**: ele tentaria ler um NeuroSky que não está nesse PC. Se já estiver rodando: `docker compose --profile live stop acquisition-a`.
- Painel do operador: **http://localhost:3000**.

## 6. PC-JOGO: NeuroSky e aquisição

1. **Só o ThinkGear Connector com o fone.** O NeuroSky conversa com **um programa por vez**: feche qualquer outro app que use o MindWave.
2. MindWave ligado e pareado, com o fone colocado (sensor na testa e clipe no lóbulo da orelha).
3. **Sonda do TGC** (opcional; salve como `sonda-tgc.py` e rode `py -3.11 sonda-tgc.py`; ela lê por 8 s):
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
4. **Aquisição** (deixe a janela aberta o tempo todo):
   ```
   git clone https://github.com/NeuroRace/edge-service.git
   cd edge-service\eeg_acquisition
   py -3.11 -m pip install "python-socketio[client]"
   set PLAYER_ID=1
   set SOURCE=real
   set EEG_HOST=127.0.0.1
   set ACQ_PORT=13854
   set BROKER_URL=http://localhost:3000
   py -3.11 acquisition_service.py
   ```
   `BROKER_URL=http://localhost:3000` funciona por causa do redirecionamento da seção 4. Sem ele, use `http://192.168.50.1:3000`.

**Leitura da janela da aquisição** (vale também para a sonda):

| Aparece | Significa | O que fazer |
|---|---|---|
| `esense_emitted` a cada ~1 s | ✅ enviando ao broker | seguir |
| `"status": "scanning"` e `poorSignalLevel` 200 | TGC aberto, **fone não encontrado** | ligar e parear o MindWave; fechar outros apps que usam o fone |
| `poorSignalLevel` alto, sem `eSense` | fone ligado, **sem contato** | ajustar sensor e clipe; limpar a pele |
| erro na porta 13854 | TGC **fechado** | abrir o ThinkGear Connector |
| erro de conexão com o broker | aquisição não chega ao painel | refazer o teste `curl.exe` da seção 4 |

## 7. A corrida (operada pelo painel)

| # | Onde | Faz | Passa se |
|---|---|---|---|
| 1 | Painel | olha o jogador 1 | bolinha **verde / conectado**, atenção mudando |
| 2 | Painel | digita e-mail(s) → **Registrar jogadores** | cartão **Registrado** |
| 3 | PC-JOGO | abre o jogo e dá a largada | cartão **Correndo**; o carro anda conforme a atenção |
| 4 | PC-JOGO | jogador cruza a linha | cartão **Finalizada** |
| 5 | Painel | repete com outra dupla | nada trava entre corridas |

- **Regra de ouro:** registrar os e-mails **antes** da largada, e **só largar com o jogador 1 verde**. O broker aceita corrida sem nenhum pacote de EEG (`packets: []`, visto em 25/09). Com a nuvem ligada, ela vira resultado no ranking sem dado nenhum.
- **Sintoma do ensaio:** o painel foi para "Correndo", mas o carro não andou e não havia sinal. Causa: aquisição parada ou sem enviar (seção 6).
- Com o dispatcher desligado, a corrida fica na fila local (`docker compose exec redis redis-cli LLEN dispatch:queue`) e **o ranking do site não muda**. Isso é o esperado no ensaio.

### Testes de falha (depois da corrida normal)
| Provoque | Espere no painel |
|---|---|
| tirar o fone da cabeça | qualidade cai de **boa** para **fraca** ou **sem** |
| desligar o MindWave | em ~10 s: banner **"Leitor do jogador 1 sem sinal"** |
| religar o MindWave | sinal volta **sem reiniciar nada** (reconexão com espera de até 10 s) |
| tirar o cabo de rede por 20 s | sem sinal → volta sozinho |
| largada sem registrar e-mails | banner vermelho **"NÃO será salva"** |

### Ensaiar sem o jogo
`data_broker/e2e/jogo-falso.js` faz o papel do jogo: dá largada e chegada **sem inventar EEG**, então o sinal real do NeuroSky vai para a corrida. Não use o `race-producer.js` com NeuroSky: ele emite telemetria falsa e mistura com o sinal real.
```bash
cd edge-service/data_broker && npm ci        # 1ª vez
node e2e/jogo-falso.js http://localhost:3000 60 1
```

## 8. No dia do evento (com a nuvem)
1. No PC-PAINEL, crie o `.env` da raiz (`API_URL` + `EDGE_INGEST_TOKEN`) conforme o `banca-runbook.md` §0 e suba o broker de novo. `/health` → `dispatcher.enabled: true`.
2. Faça **uma** corrida de checagem com o e-mail de um apresentador e confira **Enviada ✓** e a corrida em `/ranking`.
3. Mantenha as regras: sinal verde antes da largada e e-mail registrado antes da largada.

## 9. Encerrar
- **PC-JOGO:** apagar o `portproxy` (seção 4) e voltar ao IP automático:
  ```
  netsh interface ipv4 set address name="Ethernet" source=dhcp
  ```
- **PC-PAINEL:** voltar ao IP automático (mesmo comando) e, se quiser, remover a regra de firewall:
  ```
  netsh advfirewall firewall delete rule name="NeuroRace broker"
  ```
- **Fila de teste:** confira que só há corridas de ensaio (`redis-cli LRANGE dispatch:queue 0 -1`) antes de `docker compose --profile live down -v`. **Nunca** use `-v` com corridas reais na fila.

## Pendências conhecidas
- **Corrida sem pacotes é aceita** (seção 7). Candidata a issue: o edge deveria recusar ou marcar corrida sem EEG.
- **NEU-102 (LGPD)** vai mudar o painel: aceite do termo antes do e-mail e menores sempre anônimos. Refazer a seção 7 depois dela.
- **NEU-86:** a fonte NeuroSky ou bot é fixa ao subir o Docker.
- **NEU-92:** com a nuvem fora do ar, a fila trava por minutos por corrida.
- O endereço do broker **no jogo** é `localhost:3000` fixo. O `portproxy` resolve, mas deixar o endereço configurável no jogo tira essa dependência (game-engine).
