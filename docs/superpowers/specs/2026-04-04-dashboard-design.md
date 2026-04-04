# Dashboard de Controle — NeuroRace

**Data:** 2026-04-04
**Branch:** feature/eeg-persistence-dispatch
**Escopo:** Interface de operação e monitoramento ao vivo da corrida neural

---

## Objetivo

Criar uma Dashboard HTML que sirva dois propósitos simultâneos:

1. **Operador:** registrar jogadores antes da corrida e monitorar conectividade dos headsets durante a corrida.
2. **Público:** exibir dados neurais ao vivo de forma visualmente atraente em tela de apresentação.

---

## Tecnologia

- **Arquivo único:** `data_broker/dashboard.html`
- **Sem build step:** bibliotecas carregadas via CDN
  - `socket.io-client` — conexão em tempo real com o broker
  - `Chart.js` — gráfico de atenção em tempo real
- **Servido pelo próprio `data_broker`** via rota `GET /`

---

## Fases da Dashboard

### Fase SETUP (estado inicial)

- Header exibe badge `● SETUP`
- Formulário de registro visível:
  - Input: Player 1 Email
  - Input: Player 2 Email
  - Botão "Registrar Corrida" — desabilitado enquanto algum campo estiver vazio
- Ao clicar em Registrar: `POST /api/players` com `{ player1Email, player2Email }`
  - Sucesso: exibe feedback inline verde
  - Erro: exibe mensagem de erro inline
- Cards dos players exibem estado `Aguardando dados...`

### Detecção de sessão ativa (reconexão)

Ao carregar a página, a dashboard faz `GET /api/session/current`:

- `status === "active"` → pula direto para fase RACE, oculta o formulário automaticamente
- `status === "none"` → permanece na fase SETUP

Isso garante que recarregar a página durante uma corrida não exiba o formulário de registro.

### Transição SETUP → RACE

- Disparada ao receber o evento Socket.IO `raceStarted`
- Formulário oculto com transição suave (opacity + height)
- Header troca para badge `● RACE`
- O formulário não é removido do DOM — apenas ocultado via CSS

### Fase RACE

- Formulário oculto
- Cards dos players atualizados em tempo real via eventos `eSense`
- Sidebar de dispatch atualizada via eventos `dispatchStatus`

---

## Layout

```
┌─────────────────────────────────────────────┐
│  NEURORACE                       ● SETUP     │  ← header
├─────────────────────────────────────────────┤
│  [player1@email]  [player2@email] [Registrar]│  ← formulário (oculto na fase RACE)
├──────────────────────────┬──────────────────┤
│  PLAYER 1   │  PLAYER 2  │  DISPATCH QUEUE  │
│             │            │                  │
│  87%  54%   │  62%  41%  │  ✓ job_a1b2      │
│  [gráfico]  │  [gráfico] │  ⏳ job_c3d4     │
│  ● SIGNAL OK│  ● CHECK H │  ✗ job_e5f6      │
└─────────────┴────────────┴──────────────────┘
```

- **Coluna esquerda + centro (2/3):** dois cards de player lado a lado
- **Coluna direita (1/3):** sidebar de dispatch queue com scroll

---

## Card de Player

Cada card exibe:

| Elemento | Descrição |
|---|---|
| Label | `PLAYER 1` / `PLAYER 2` |
| Attention % | Valor numérico grande + barra de progresso (gradiente índigo→violeta para P1, âmbar→vermelho para P2) |
| Meditation % | Valor numérico grande + barra de progresso (azul→ciano) |
| Gráfico de Atenção | Line chart Chart.js, últimos 30 pontos, atualiza a cada evento `eSense` |
| Badge de sinal | Ver mapeamento abaixo |

### Mapeamento de `poorSignalLevel`

| Valor | Badge |
|---|---|
| `0` | `● SIGNAL OK` — verde |
| `1–199` | `● CHECK HEADSET` — âmbar |
| `200` | `● SEM SINAL` — vermelho |
| `null` / ausente | `● AGUARDANDO` — cinza |

---

## Sidebar — Dispatch Queue

- Lista de jobs indexada por `jobId` (mapa em memória no frontend)
- Cada item exibe: `jobId` (truncado), email do player, ícone de status
- Máximo de **20 jobs** visíveis simultaneamente

### Estados dos jobs

| Status | Ícone | Cor | Comportamento |
|---|---|---|---|
| `sent` | ✓ check | Verde | Remove automaticamente após **10 segundos** |
| `retry` | ⟳ spinner | Âmbar | Persiste; exibe `tentativa N` |
| `expired` | ✗ | Vermelho | Permanece visível (diagnóstico) |

---

## Evento Socket.IO novo: `dispatchStatus`

Emitido pelo `api_dispatcher.js` para todos os clientes conectados.

**Payload:**
```json
{
  "jobId": "string",
  "playerId": 1,
  "playerEmail": "string",
  "status": "sent" | "retry" | "expired",
  "attempts": 0,
  "timestamp": 1712345678000
}
```

> `playerEmail` é incluído para que a sidebar possa exibir a qual jogador o job pertence sem lookup adicional.

---

## Mudanças por arquivo

### `data_broker/dashboard.html` *(novo)*

Arquivo único com toda a UI. Estrutura interna:

- `<style>` — CSS Dark Pro inline (sem framework)
- `<body>` — markup semântico das duas fases
- `<script>` — lógica de conexão Socket.IO, atualização de cards, Chart.js, gestão da fila

### `data_broker/http_server.js`

Duas novas rotas:

- `GET /` — lê `dashboard.html` com `fs.readFile`, responde com `Content-Type: text/html; charset=utf-8`
- `GET /api/session/current` — chama `session.getCurrentSession()`, retorna `{ status, player1Email, player2Email }` ou `{ status: "none" }`

### `data_broker/session_manager.js`

Novo método público:

```js
async function getCurrentSession() {
  const s = await redis.hgetall('session:current');
  if (!s || !s.id) return { status: 'none' };
  return { status: s.status, player1Email: s.player1Email, player2Email: s.player2Email };
}
```

Exposto no objeto retornado por `createSessionManager`.

### `data_broker/api_dispatcher.js`

- `createDispatcher` recebe parâmetro opcional `emitFn = () => {}`
- Chamado em três pontos de `processJob`:
  - Sucesso HTTP: `emitFn('dispatchStatus', { jobId, playerId, playerEmail, status: 'sent', attempts, timestamp })`
  - Retry: `emitFn('dispatchStatus', { ..., status: 'retry', attempts })`
  - Job expirado: `emitFn('dispatchStatus', { ..., status: 'expired', attempts })`
- `playerEmail` requer que `job.payload.email` seja passado no job (já existe em `session_manager.js`)

### `data_broker/index.js`

```js
const emitFn = (event, payload) => io.emit(event, payload);
const dispatcher = createDispatcher(redis, config, log, fetch, undefined, emitFn);
```

> A assinatura de `createDispatcher` mantém `fetchFn` e `sleepFn` antes de `emitFn` para não quebrar os testes existentes.

---

## Estilo Visual

- **Paleta:** Dark Pro — `#111827` fundo, `#1f2937` cards, `#374151` bordas
- **Acentos Player 1:** índigo `#6366f1` → violeta `#8b5cf6`
- **Acentos Player 2:** âmbar `#f59e0b` → vermelho `#ef4444`
- **Tipografia:** `system-ui, sans-serif`; valores numéricos em `font-weight: 800`
- **Sinal OK:** `#34d399` verde; **Check Headset:** `#f59e0b` âmbar; **Sem sinal:** `#ef4444` vermelho

---

## Testes

- `http_server` — testes unitários para `GET /` (verifica Content-Type) e `GET /api/session/current` (mock de session retornando `active` e `none`)
- `api_dispatcher` — testes unitários verificam que `emitFn` é chamado com payload correto nos três cenários (sent, retry, expired)
- `session_manager` — teste unitário para `getCurrentSession` (sessão ativa e ausente)

---

## Fora de escopo

- Autenticação na Dashboard
- Histórico de corridas anteriores
- Responsividade mobile (é uma tela de operação/apresentação em desktop/projetor)
