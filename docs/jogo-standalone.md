# Jogo no estande: standalone, não empacotado nem no Play do editor (NEU-184)

Como abrir o jogo (Unreal 5.5) no PC central, à mão ou por um agente (Claude Code), e por que esse é o jeito escolhido para o NEXT. Tudo aqui foi executado no ensaio de 23/10 (NEU-184), exceto o que está marcado como **não testado**.

## Decisão (23/10, véspera do NEXT)

| Jeito | NEXT? | Por quê |
|---|---|---|
| **Standalone** (`UnrealEditor.exe <uproject> -game -fullscreen`) | **Sim** | Testado em 23/10: conectou no broker, corrida completa, tempo do broker e `totalTime` do jogo com diferença de até 0,4 s; tela cheia medida (janela do tamanho do monitor, sem borda). |
| Play do editor (PIE) | **Não** | Corridas de ~2 min saíram 2,3 a 5 s mais longas no broker (que vai para o site) do que na tela do jogo. Hipótese, não provada: o cronômetro do jogo perde tempo com o editor carregando a máquina. Abrir o PIE com outro jogo conectado também dobra a conexão do jogo e os eventos. |
| Empacotado (`.exe`) | **Não** (depois do NEXT) | Nunca foi gerado nem testado (NEU-146, pergunta 4). O plugin `SocketIOClient` 2.9.0 está em `Plugins/` de um projeto só-Blueprint (sem `Source/`), o caso em que o autor do plugin diz que o pacote sai sem o plugin (issue #68 do `getnamo/SocketIOClient-Unreal`). Ver "Empacotar (depois do NEXT)". |

Custo do standalone: precisa do Unreal Engine 5.5 instalado no PC do jogo e leva **~2,5 a 3 min** para abrir (144 s e 178 s nas duas medições).

| | Valor (central do NEXT) |
|---|---|
| Executável | `C:\Program Files\Epic Games\UE_5.5\Engine\Binaries\Win64\UnrealEditor.exe` |
| Projeto (`<uproject>`) | `C:\IC\2026\NeuroRaceNext2026VersaoFinal\NeuroRaceNEXT26 5.5\NeuroRaceRemake.uproject` |
| Mapa inicial | `MenuLevel` (`Config/DefaultEngine.ini`, `GameDefaultMap`) |
| Broker | `localhost:3000` fixo no jogo: o jogo roda no PC central, junto do broker |

## À mão (operador)

### Uma vez: o atalho

1. Clique direito na área de trabalho → **Novo → Atalho**.
2. Em "local do item", cole (com as aspas):
   ```
   "C:\Program Files\Epic Games\UE_5.5\Engine\Binaries\Win64\UnrealEditor.exe" "C:\IC\2026\NeuroRaceNext2026VersaoFinal\NeuroRaceNEXT26 5.5\NeuroRaceRemake.uproject" -game -fullscreen
   ```
3. Nome: **NeuroRace - Jogo**.

Em outro PC, troque os dois caminhos pelos de lá. Sem `-fullscreen`, o jogo abre em janela.

### No dia

1. **Feche o Unreal Editor**, se estiver aberto. Nunca aperte **Play** no editor durante o evento.
2. Suba o central primeiro (`scripts\iniciar-central.bat`, `docs/banca-runbook.md`). O jogo conecta em `localhost:3000`.
3. Clique duas vezes em **NeuroRace - Jogo** e espere ~3 min (tela preta enquanto carrega).
4. No painel (`http://localhost:3000`), a faixa do topo mostra **Jogo OK**. Para ter certeza de que há um jogo só: `curl.exe -s localhost:3000/api/status` → `"game":{"connections":1`.
5. **Depois de cada corrida, clique em Parar corrida** e confirme no mesmo botão (rápido: ele se desarma em poucos segundos). O jogo não avisa o fim sozinho (NEU-185); sem o Parar, o Largar fica travado por até 10 min.
6. Para fechar o jogo: **Alt+F4** (**não testado** em tela cheia) ou Gerenciador de Tarefas → `UnrealEditor.exe`.

### Problemas

| O que aparece | O que fazer |
|---|---|
| Painel sem **Jogo OK** depois de 4 min | O broker está de pé (`curl.exe -s localhost:3000/health`)? O jogo ainda está aberto? Feche e abra o atalho de novo, com o broker já de pé. |
| `/api/status` com `game.connections` 2 | Tem um editor com Play ou um segundo jogo aberto. Feche o que sobra: com dois, cada evento chega duas vezes. |
| Tempo no site maior que o da tela do jogo | Confira que o jogo veio do atalho (`-game`), não do Play do editor. |
| Largar travado com os dois já chegados | Parar corrida (passo 5). |

## Pelo Claude Code (autônomo)

Para um agente abrir o jogo, rodar corridas pelo painel e devolver a máquina como estava. Comandos em PowerShell, os mesmos do ensaio de 23/10.

**Regras:**

- Uma instância de jogo só. Nunca abrir o Play do editor nem um segundo `-game`.
- Quem joga é uma pessoa na frente da máquina; o agente larga, para e confere. Peça a ela para avisar quando o jogo estiver no menu antes de cada Largar.
- Em PC de desenvolvimento, sem `-fullscreen`: a tela cheia toma a tela de quem está usando.
- Ao terminar, fechar o jogo e restaurar `GameUserSettings.ini` (passos 6 e 7).

### 1. Pré-condições

```powershell
curl.exe -s http://localhost:3000/health                      # broker de pé
(Invoke-RestMethod http://localhost:3000/api/status).game.connections   # tem que ser 0
Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" | Select-Object ProcessId, CommandLine
```

Se `game.connections` não for 0, ou se já houver um `UnrealEditor.exe ... -game`, pare e pergunte: há outro jogo conectado.

### 2. Guardar a configuração do jogo

Ao sair normalmente, o `-game` grava a qualidade gráfica detectada (`[ScalabilityGroups]`) em `Saved\Config\WindowsEditor\GameUserSettings.ini`, o mesmo arquivo que o editor usa.

```powershell
$proj = "C:\IC\2026\NeuroRaceNext2026VersaoFinal\NeuroRaceNEXT26 5.5"
$evid = "C:\Users\<voce>\neurorace-e2e\<data>"                 # pasta de evidências, fora do repo
New-Item -ItemType Directory -Force "$evid\logs" | Out-Null
Copy-Item "$proj\Saved\Config\WindowsEditor\GameUserSettings.ini" "$evid\GameUserSettings.antes.ini"
```

### 3. Abrir

```powershell
$p = Start-Process -FilePath "C:\Program Files\Epic Games\UE_5.5\Engine\Binaries\Win64\UnrealEditor.exe" `
  -ArgumentList @("`"$proj\NeuroRaceRemake.uproject`"", '-game', "-abslog=`"$evid\logs\game.log`"") -PassThru
$p.Id
```

`-abslog` manda o log para a pasta de evidências, sem disputar o `Saved\Logs` de um editor aberto. No evento, acrescente `'-fullscreen'`.

### 4. Esperar o jogo conectar (até 6 min)

```powershell
$fim = (Get-Date).AddMinutes(6)
do {
  Start-Sleep -Seconds 2
  $c = (Invoke-RestMethod http://localhost:3000/api/status).game.connections
  $vivo = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
} until ($c -gt 0 -or -not $vivo -or (Get-Date) -gt $fim)
"conexoes do jogo: $c; processo vivo: $([bool]$vivo)"
```

Medido: 144 a 178 s. Se o processo morrer, leia o fim de `$evid\logs\game.log`.

### 5. Rodar corridas pelo painel

Com o Playwright em `http://localhost:3000`: preencha `#email1` e `#email2` (ou **Sem cadastro**, ou P2 em **Bot**) e clique em **Largar**. Acompanhe o log do broker (`docker logs -f --timestamps <broker>`) até as duas chegadas (`race_result_persisted`, `dispatch_success`).

O Parar tem dois cliques, e o primeiro se desarma em poucos segundos. Pelo Playwright, os dois cliques saem num `browser_evaluate` só:

```js
async () => {
  const b = document.querySelector('[data-stop]');
  b.click(); await new Promise(r => setTimeout(r, 400));
  const armado = b.textContent;            // "Confirmar: parar? ..." ou "Confirmar: parar sem gravar?"
  b.click(); await new Promise(r => setTimeout(r, 2500));
  return { armado, dica: [...document.querySelectorAll('main section:first-of-type .actions span')].map(e => e.innerText) };
}
```

O que conferir em cada corrida:

- broker: `race_started` com os `playerNKind` certos; `race_result_persisted` com `packets` > 0; `dispatch_success` `created`;
- depois do Parar: `race_stopped` com `saved`, `stopRace`, `raceStopped` do jogo e `race_stopped_confirmed`;
- tempo: `hasFinished.totalTime` do jogo contra o intervalo `raceStarted` → `hasFinished` no broker (até ~0,5 s no standalone).

### 6. Fechar

```powershell
Stop-Process -Id $p.Id -Force
```

Fechar pelo processo não grava o `GameUserSettings.ini`; sair pelo jogo grava.

### 7. Devolver como estava

```powershell
$a = "$evid\GameUserSettings.antes.ini"; $b = "$proj\Saved\Config\WindowsEditor\GameUserSettings.ini"
if ((Get-FileHash $a).Hash -ne (Get-FileHash $b).Hash) { Copy-Item $a $b -Force }
(Get-FileHash $a).Hash -eq (Get-FileHash $b).Hash          # True
```

### Teste ponta a ponta numa máquina só (como no ensaio de 23/10)

Para testar sem tocar no volume `edge-service_redis-data` (corridas reais guardadas) e com o ThinkGear aberto e pareado:

1. Override fora do repo (ex.: `nr-e2e.override.yml` numa pasta temporária). O `acquisition-a-sim` fala com o `simulator-a` pela rede interna, e a porta no host só servia para depurar:
   ```yaml
   services:
     simulator-a:
       ports: !reset []
   ```
2. Subir num projeto separado: `docker compose -p nr-e2e -f docker-compose.yml -f <override> --profile banca up -d redis broker simulator-a simulator-b acquisition-a-sim acquisition-b-sim`.
3. Com o `.env` da raiz, as corridas vão para a **produção**: use contatos de teste fáceis de achar (ex.: `e2e-<data>-p1@example.com`) e apague-os no fim, com ok do time. Sem o `.env`, ficam em `dispatch:queue`.
4. Desmontar: `docker compose -p nr-e2e --profile banca down` e `docker volume rm nr-e2e_redis-data`. Nunca `down -v` no projeto padrão `edge-service`. Os contêineres têm `restart: unless-stopped`: se ficarem de pé, voltam com o Docker e ocupam a 3000 do broker do evento.

## Empacotar (depois do NEXT)

**Não testado.** Antes de trocar o standalone pelo pacote, o pacote precisa passar nos mesmos critérios.

1. **Visual Studio 2022** com "Game development with C++" (no central há o 17.13).
2. **Plugin no pacote:** o caminho documentado pelo autor do plugin é converter o projeto para C++, em **Tools → New C++ Class → None → Create Class**, e deixar compilar. Mudança no projeto do jogo: é com o dono do jogo (Thiago).
3. **Gerar em Development**, não Shipping (o Shipping não grava log e tem o bug #445 do plugin): **Platforms → Windows → Package Project**, numa pasta curta fora do projeto (ex.: `C:\NR\pacote`). Pela linha de comando:
   ```
   "C:\Program Files\Epic Games\UE_5.5\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun -project="<uproject>" -noP4 -platform=Win64 -clientconfig=Development -build -cook -stage -pak -archive -archivedirectory="C:\NR\pacote"
   ```
4. **Atalho:** `"C:\NR\pacote\Windows\<Projeto>.exe" -fullscreen`.
5. **Passa se:**
   - o pacote conecta no broker (Jogo OK no painel);
   - 20 ciclos Largar → Parar sem crash;
   - tempo do broker e `totalTime` com diferença de até 0,5 s;
   - mesmo comportamento de `raceStopped` (NEU-185).
