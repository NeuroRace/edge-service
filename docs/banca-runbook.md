# Roteiro do operador — banca (28/08/2026) e NEXT FIAP

Como subir e operar o estande do NeuroRace sem NeuroSky (2 jogadores simulados), do zero até a corrida aparecer no site. Cada passo tem o que você deve **ver**; se não vir, pare e use a seção "Se algo der errado". Ensaiado do zero em 27/08 (ver NEU-82).

## 0. Véspera (10 min)
- [ ] Docker Desktop instalado e aberto; `git clone` do `edge-service` na branch/`main` que contém os PRs #15, #16 e #17.
- [ ] Copie `.env.example` (raiz do repo) para `.env` e preencha `API_URL` e `EDGE_INGEST_TOKEN` (token: Pedro / `cloud-backend/.secret.prod.env`). **Nunca** commite o `.env`.
- [ ] Baixe as imagens com internet boa: `docker compose --profile banca build` (1ª vez leva alguns minutos).
- [ ] Contas dos apresentadores **já criadas e confirmadas** no site (produção manda no máximo **2 e-mails de confirmação por hora** — NEU-84). Quem for demonstrar "cadastre-se" precisa de um e-mail que abra na hora.
- [ ] Combine com quem roda o jogo: ele conecta em `http://<IP-desta-máquina>:3000` e emite `raceStarted` na largada e `hasFinished {playerId: 1|2}` na chegada (`docs/event-contracts.md`).

## 1. Subir o estande (2 min)

### Dois PCs pelo cabo (NEXT, NEU-144): um clique em cada
Antes, uma vez por PC: IP fixo do cabo (central `192.168.50.1`, coletor `192.168.50.2`) e Python 3.11 com `gesture_detector\requirements.txt` (playbook da NEU-137, Etapas 0 e 1).

1. **PC central:** clique duas vezes em `scripts\iniciar-central.bat`. Ele sobe Redis, broker (com o painel) e o fone do P1, e abre o gesto do P1. Nunca sobe P2.
2. **PC coletor:** clique duas vezes em `scripts\iniciar-coletor.bat`. Ele testa o central pelo cabo, sobe só o fone do P2 e abre o gesto do P2. Nunca sobe broker: **dois brokers foi o que quebrou a banca de 30/09**.
3. No painel do central (`http://localhost:3000`), aba **Diagnóstico**: as peças dos dois PCs em OK.

O que cada janela diz, e o que fazer:

| A janela diz | O que fazer |
|---|---|
| `NAO achei o central em 192.168.50.1` (coletor) | Cabo plugado? Central ligado com o `.bat` aberto? IP certo no topo do `.bat`? Ele tenta de novo sozinho a cada ~8 s. |
| `este PC nao tem o IP 192.168.50.1 do cabo` (central) | Configure o IP fixo do cabo e abra o `.bat` de novo. Sem ele o broker não sobe. |
| `ThinkGear Connector esta FECHADO` (modo NeuroSky) | Abra o ThinkGear e pareie o fone. A leitura tenta sozinha. |
| `ThinkGear Connector esta ABERTO e ocupa a porta do simulador` (modo `sim`) | Feche o ThinkGear. O `.bat` espera e segue sozinho. |
| `este PC tem um broker rodando` (coletor) | `docker stop <id>` do que ele mostrar. |
| `Nuvem DESLIGADA` (central, no evento) | Falta o `.env` da raiz: as corridas ficam guardadas e não aparecem no site. |

* **Ensaio sem NeuroSky:** `iniciar-central.bat sim` e `iniciar-coletor.bat sim` (simulador no lugar do fone).
* **Ligar sozinho com o Windows:** atalho do `.bat` em `shell:startup` (Win+R).
* **Peça que cai volta sozinha:** todas as peças têm `restart: unless-stopped` no compose (NEU-156). O gesto volta pelo laço do `.bat`. Para parar de vez, feche a janela do `.bat`.
* **Atualizar:** `git pull` e clique de novo. O `.bat` reconstrói o que mudou (`--build`).

### Um PC só, sem coletor (banca antiga)
```bash
cd edge-service
docker compose --profile banca up -d --build
docker compose --profile banca ps          # 6 serviços "Up": redis, broker, simulator-a/b, acquisition-a-sim/b-sim
curl -s localhost:3000/health | python3 -m json.tool
```
Você deve ver em `/health`: `"status": "ok"`, `"dispatcher": {"enabled": true, "target": "wtaulbdkgrnrtbfezaxw.supabase.co", ...}`.
Se `"enabled": false` → o `.env` da raiz não foi lido (ver "Se algo der errado").

Abra **http://localhost:3000/** no navegador do kiosk (essa é a tela do operador). Você deve ver: **sem banner** no topo, os dois blocos de "Sinal ao vivo" com bolinha verde e "conectado", e "Nuvem: ligada → …".

## 2. Cada corrida (o que você faz, na ordem)
1. **Largar.** Digite o e-mail dos 2 jogadores e clique **Largar**: o painel registra os dois e manda o jogo largar (NEU-140). Quem não quer cadastro: marque **Sem cadastro** no card (a pessoa joga, mas não entra no ranking). Com uma pessoa só, ela joga no **P1** e o **P2 fica em Bot**. O Largar trava, com o motivo escrito ao lado, quando falta contato, quando o jogo não está conectado, quando o P1 está em Bot e o P2 não, ou quando ainda tem gente correndo.
   * **O jogo não obedece o Largar?** Use **Só registrar (o jogo larga)** e largue pelo jogo, como antes. O registro vale 1 hora.
   * **O jogo largou sem registro?** O card mostra **Sem cadastro nesta corrida** e o topo fica vermelho. Digite o e-mail e clique **Vincular a esta corrida** antes de a pessoa terminar.
   * **Precisa cancelar?** **Parar corrida** e confirme no mesmo botão. Nada é gravado e o painel manda o jogo parar (`stopRace`). Se o painel estiver sem conexão com o broker, a dica pede para parar também no jogo. Os e-mails voltam para os campos.
2. **Largada** (o jogo emite `raceStarted`). Os cartões passam a **Correndo**; os e-mails ficam travados; o sinal dos dois jogadores continua vivo.
3. **Chegada** (o jogo emite `hasFinished` de cada jogador). Cartão → **Finalizada — enviando…** → **Enviada ✓** em ~2 s; a corrida aparece no histórico do bloco Nuvem.
4. **Mostrar no site.** `https://neurorace-v2.vercel.app/ranking` (público, atualiza ao recarregar) e o dashboard do jogador (ele entra com a conta do mesmo e-mail; se ainda não tem conta, cria com o **mesmo e-mail** e a corrida aparece após confirmar).
5. Próxima dupla: volte ao passo 1 (os campos já estão liberados).

**Regra de ouro: registrar ANTES da largada.** Se a corrida começar sem registro, o banner vermelho avisa "NÃO será salva" — a corrida não vai para a nuvem e não há como recuperar depois (NEU-73).

## 3. Se algo der errado (o banner diz o quê)
| O que a tela mostra | O que fazer |
|---|---|
| **Corrida iniciada sem jogadores registrados — NÃO será salva** | Deixe terminar; registre os e-mails e rode outra corrida. |
| **Nuvem DESLIGADA — API_URL não definido** | O `.env` da raiz não foi lido. `docker compose --profile banca down && docker compose --profile banca up -d`. Confira `docker compose config \| grep API_URL`. As corridas já feitas estão na fila e sobem quando religar. |
| **Nuvem DESLIGADA — EDGE_INGEST_TOKEN vazio** | Idem, preencha o token no `.env`. |
| **N corrida(s) aguardando envio há mais de 30 s** | Internet caiu ou lenta. Nada se perde: continue as corridas; elas sobem sozinhas quando a rede voltar. Uma corrida com problema não trava as outras: ela fica em "nova tentativa" e as seguintes continuam sendo enviadas (NEU-92). O ranking no telão atualiza depois. |
| **Leitor do jogador N sem sinal** | Com simulador: `docker compose --profile banca restart simulator-a` (ou `-b`). Com NeuroSky: verifique o par/USB; o acquisition reconecta sozinho. |
| **Jogador N registrado, mas o leitor está sem sinal** | Não dê a largada: sem EEG a corrida será descartada. Resolva o sinal como na linha acima e espere a bolinha ficar verde. |
| **Uma corrida foi descartada porque o leitor ficou sem sinal de EEG** | O fone caiu, ficou sem bateria ou largou sem sinal (NEU-104). Nada foi para a nuvem: arrume o sinal, registre o e-mail de novo e peça para a pessoa correr outra vez. |
| **Falhou: exhausted** no histórico | A nuvem ficou fora por mais de ~2 min naquela corrida. Recupere no painel: bloco Nuvem → "Não subiram" → **Reenviar** (o registro fica guardado no dead-letter; sem o painel, `README.md` → "Dead-letter, historico e requeue"). |
| **Sem conexão em tempo real com o broker** | Recarregue a página; se persistir, `docker compose --profile banca logs broker --tail 50`. |

## 4. Sem internet no estande
Tudo que é local funciona (jogo, sinal, tela do operador, registro). As corridas ficam guardadas na fila do Redis (volume `redis-data`, sobrevive a reinício) e sobem sozinhas quando a internet voltar — inclusive se você desligar e ligar o Docker depois. Só o site (ranking/dashboard) não atualiza enquanto isso.

## 5. Encerrar / reiniciar
- Pausar sem perder nada: `docker compose --profile banca down` (o volume do Redis fica).
- Ver filas: `docker compose exec redis redis-cli LLEN dispatch:queue` e `docker compose exec redis redis-cli ZCARD dispatch:retry` (os dois devem ser 0 ao fim do dia).
- Zerar tudo (só se tiver certeza de que nada ficou na fila): `docker compose --profile banca down -v`.

## 6. Checklist de 1 minuto antes da banca
- [ ] `/health` → `dispatcher.enabled: true` e `target` correto.
- [ ] Tela sem banner; dois sinais "conectado".
- [ ] Corrida de teste registrada com um e-mail de teste → "Enviada ✓" → apareceu no `/ranking`.
- [ ] Telão com `/ranking` aberto; celular com o dashboard de um apresentador logado.
