@echo off
rem NEU-144: PC coletor (P2) com um clique. Liga o fone e o gesto do P2 e conecta no
rem broker do PC central pelo cabo. NUNCA sobe broker nem painel: dois brokers foi o que
rem quebrou a banca de 30/09.
rem
rem Uso: clique duas vezes (ou atalho em shell:startup). Para ensaio sem NeuroSky:
rem   iniciar-coletor.bat sim
rem Para parar: feche esta janela e rode
rem   docker compose -f docker-compose.collector.yml --profile live --profile sim-dual stop
rem Nunca use "down -v".

rem ---- Ajuste aqui se precisar ----
if not defined CENTRAL_IP set CENTRAL_IP=192.168.50.1
if not defined CAMERA_INDEX set CAMERA_INDEX=0
rem ----------------------------------

set MODO=neurosky
if /i "%~1"=="sim" set MODO=simulador
set BROKER_URL=http://%CENTRAL_IP%:3000
title NeuroRace - PC coletor (P2) - %MODO%
cd /d "%~dp0.."

echo ============================================================
echo  NeuroRace - PC coletor (P2) - modo %MODO%
echo  Central: %BROKER_URL%
echo ============================================================

:docker
docker info >nul 2>&1 && goto docker_ok
echo [1/4] Esperando o Docker Desktop abrir...
ping -n 4 127.0.0.1 >nul
goto docker
:docker_ok
echo [1/4] Docker pronto.

rem NEU-157: no evento, so o cabo pode ver as pecas. Conteiner com porta em 0.0.0.0 fica
rem aberto para quem estiver no Wi-Fi do estande (no teste de 15/10: um Postgres de outro
rem projeto e um broker antigo). O NeuroRace so publica em 127.0.0.1 e no IP do cabo, entao
rem tudo que aparecer aqui e de fora. Avisa e nao para: quem decide e o dono do PC.
for /f "tokens=1,*" %%i in ('docker ps --format "{{.Names}} {{.Ports}}" ^| findstr /l /c:"0.0.0.0:" /c:"[::]:"') do (
  echo.
  echo  ATENCAO: o conteiner %%i esta aberto para a rede do evento ^(%%j^).
  echo  Se ele nao e do NeuroRace, pare durante o evento com:
  echo    docker stop %%i ^&^& docker update --restart=no %%i
  echo.
)

rem O broker so pode existir no central. Um broker aqui recebe o P2 no lugar errado.
for /f %%i in ('docker ps -q --filter "name=broker"') do (
  echo.
  echo  ATENCAO: este PC tem um broker rodando ^(conteiner %%i^).
  echo  No coletor isso manda o P2 para o lugar errado. Pare com:  docker stop %%i
  echo.
)

:central
curl.exe -s -m 3 %BROKER_URL%/health | findstr /c:broker >nul && goto central_ok
echo [2/4] NAO achei o central em %CENTRAL_IP%. Confira:
echo        - o cabo esta plugado nos dois PCs;
echo        - o central esta ligado, com o iniciar-central.bat aberto;
echo        - o IP do central no topo deste arquivo ^(hoje %CENTRAL_IP%^).
echo        Tentando de novo em 5 s...
ping -n 6 127.0.0.1 >nul
goto central
:central_ok
echo [2/4] Central encontrado em %CENTRAL_IP%.

rem O ThinkGear Connector e o simulador usam a mesma porta 13854 (playbook, 15/10). Olha o
rem processo, nao a porta: depois de reiniciar, o simulador volta sozinho e ocupa a porta.
:thinkgear
set TG=fechado
tasklist /fi "imagename eq ThinkGear Connector.exe" | findstr /i /c:"ThinkGear" >nul && set TG=aberto
if "%MODO%"=="simulador" if "%TG%"=="aberto" (
  echo [3/4] O ThinkGear Connector esta ABERTO e ocupa a porta do simulador.
  echo        Feche o ThinkGear Connector ^(icone perto do relogio^). Tentando de novo em 5 s...
  ping -n 6 127.0.0.1 >nul
  goto thinkgear
)
if "%MODO%"=="neurosky" if "%TG%"=="fechado" (
  echo [3/4] ATENCAO: o ThinkGear Connector esta FECHADO. Abra-o e pareie o fone do P2.
  echo        A leitura do fone fica tentando sozinha; o painel mostra "ThinkGear do P2 fechado".
)

if "%MODO%"=="simulador" (
  docker compose -f docker-compose.collector.yml --profile sim-dual up -d --build simulator-b acquisition-b
) else (
  docker compose -f docker-compose.collector.yml --profile live up -d --build acquisition-b
)
if errorlevel 1 (
  echo [3/4] FALHOU ao subir a leitura do fone do P2. Veja a mensagem acima.
  pause
  exit /b 1
)
echo [3/4] Leitura do fone do P2 no ar. Se cair, o Docker religa sozinho.

echo [4/4] Abrindo o gesto do P2 ^(camera %CAMERA_INDEX%; a camera troca pelo painel^).
echo        Confira no painel do central, aba Diagnostico: acquisition-p2 e gesture-p2 OK.
cd gesture_detector
set PLAYER_ID=2
:gesto
py -3.11 hand_fist_detector.py
echo Gesto fechou. Religando em 3 s ^(feche esta janela para parar^).
ping -n 4 127.0.0.1 >nul
goto gesto
