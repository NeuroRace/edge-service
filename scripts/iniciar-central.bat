@echo off
rem NEU-144: PC central com um clique. Sobe Redis, broker (com o painel) e o P1, e abre o
rem gesto do P1. O P2 e do PC coletor (iniciar-coletor.bat): aqui nunca sobe P2.
rem
rem Uso: clique duas vezes (ou atalho em shell:startup). Para ensaio sem NeuroSky:
rem   iniciar-central.bat sim
rem Para parar: feche esta janela e rode
rem   docker compose -f docker-compose.yml -f docker-compose.central.yml --profile live --profile banca stop
rem Nunca use "down -v": apaga as corridas guardadas.

rem ---- Ajuste aqui se precisar ----
if not defined CENTRAL_IP set CENTRAL_IP=192.168.50.1
if not defined CAMERA_INDEX set CAMERA_INDEX=0
rem ----------------------------------

set MODO=neurosky
if /i "%~1"=="sim" set MODO=simulador
set BROKER_URL=http://localhost:3000
title NeuroRace - PC central (P1) - %MODO%
cd /d "%~dp0.."

echo ============================================================
echo  NeuroRace - PC central (P1) - modo %MODO%
echo  Painel: http://localhost:3000
echo ============================================================

rem Sem o IP do cabo na placa, o broker nao sobe ("can't bind on the specified endpoint").
ipconfig | findstr /c:"%CENTRAL_IP%" >nul || (
  echo.
  echo  ATENCAO: este PC nao tem o IP %CENTRAL_IP% do cabo. O broker nao vai subir.
  echo  Configure o IP fixo do cabo ^(roteiro, Etapa 1^) e abra este arquivo de novo.
  echo.
  pause
  exit /b 1
)

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

rem O ThinkGear Connector e o simulador usam a mesma porta 13854 (playbook, 15/10). Olha o
rem processo, nao a porta: depois de reiniciar, o simulador volta sozinho e ocupa a porta.
:thinkgear
set TG=fechado
tasklist /fi "imagename eq ThinkGear Connector.exe" | findstr /i /c:"ThinkGear" >nul && set TG=aberto
if "%MODO%"=="simulador" if "%TG%"=="aberto" (
  echo [2/4] O ThinkGear Connector esta ABERTO e ocupa a porta do simulador.
  echo        Feche o ThinkGear Connector ^(icone perto do relogio^). Tentando de novo em 5 s...
  ping -n 6 127.0.0.1 >nul
  goto thinkgear
)
if "%MODO%"=="neurosky" if "%TG%"=="fechado" (
  echo [2/4] ATENCAO: o ThinkGear Connector esta FECHADO. Abra-o e pareie o fone do P1.
  echo        A leitura do fone fica tentando sozinha; o painel mostra "ThinkGear do P1 fechado".
)

if "%MODO%"=="simulador" (
  docker compose -f docker-compose.yml -f docker-compose.central.yml --profile banca up -d --build redis broker simulator-a acquisition-a-sim
) else (
  docker compose -f docker-compose.yml -f docker-compose.central.yml --profile live up -d --build redis broker acquisition-a
)
if errorlevel 1 (
  echo [2/4] FALHOU ao subir as pecas do central. Veja a mensagem acima.
  pause
  exit /b 1
)

:broker
curl.exe -s -m 3 %BROKER_URL%/health | findstr /c:broker >nul && goto broker_ok
echo [2/4] Esperando o broker responder...
ping -n 3 127.0.0.1 >nul
goto broker
:broker_ok
echo [2/4] Broker, Redis e leitura do fone do P1 no ar. Se algum cair, o Docker religa sozinho.

rem Nuvem: com o .env da raiz as corridas sobem para o site; sem ele, ficam guardadas aqui.
curl.exe -s -m 3 %BROKER_URL%/health | findstr /c:"\"enabled\":true" >nul && (
  echo [3/4] Nuvem LIGADA: as corridas sobem para o site.
) || (
  echo [3/4] Nuvem DESLIGADA: as corridas ficam guardadas neste PC e nao aparecem no site.
)

echo [4/4] Abrindo o gesto do P1 ^(camera %CAMERA_INDEX%; a camera troca pelo painel^).
echo        Painel: http://localhost:3000 ^(aba Diagnostico mostra cada peca^).
cd gesture_detector
set PLAYER_ID=1
:gesto
py -3.11 hand_fist_detector.py
echo Gesto fechou. Religando em 3 s ^(feche esta janela para parar^).
ping -n 4 127.0.0.1 >nul
goto gesto
