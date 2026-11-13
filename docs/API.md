# Controle externo: API HTTP e servidor MCP

`npm run ui` sobe o servidor do simulador em `http://127.0.0.1:5173` com três coisas no mesmo processo:

- a **interface web** (`/`);
- a **API HTTP** (`/api/...`), descrita abaixo e listada em `GET /api`;
- o **servidor MCP** por Streamable HTTP (`POST /mcp`).

`npm run mcp` roda o servidor MCP por **stdio**, para clientes que preferem iniciar o processo
(Claude Code, Claude Desktop, Cursor). Ele fala com o servidor do simulador em `SIM_URL`
(padrão `http://127.0.0.1:5173`) e, se não encontrar um, sobe o servidor no próprio processo.

O servidor só escuta em `127.0.0.1`, sem autenticação: é para uso na própria máquina.

## Modelo: uma sessão compartilhada

O estado é uma **sessão de configuração** no servidor: o cenário inteiro (o mesmo formato de
`config/default.yaml`), uma versão que sobe a cada alteração e os **padrões**, que são o cenário carregado e o
alvo de "restaurar". A interface web, a API e o MCP leem e alteram essa mesma sessão:

- o que um agente altera aparece na hora no painel de quem está com a interface aberta, que recalcula a cena;
- o que se altera no painel o agente vê no próximo `GET`.

As simulações (`POST /api/runs`) e os quadros renderizados (`POST /api/render`) usam o cenário da sessão no
momento da chamada.

### Caminhos

Valores são endereçados por caminho com pontos, no formato do cenário. Em listas, aceita-se o índice ou o
`name` do item:

```
environment.wind.speed_ms
obstacle.height_m
dynamics.target_clearance_m        (null = não fixar a folga)
cameras.linecam.fps                (= cameras.0.fps)
cameras.track_b.position           ([x, y, z] em metros)
cameras.track_a.calibration_error.rotation_sigma_deg
aircraft.markers_enabled
```

Unidades no cenário são SI: metros, segundos, quilos, graus. `GET /api/params` lista os parâmetros
documentados com faixa, opções, unidade exibida na interface (`unit_display`) e o fator `scale` entre as duas
(ex.: exposição guardada em s, exibida em ms, `scale` 1000). Qualquer outra chave existente do cenário também
pode ser alterada; a validação então só confere o tipo.

## Rotas

| Método e rota | Corpo | Resposta |
|---|---|---|
| `GET /api` | — | índice das rotas |
| `GET /api/session` | — | `{version, scenario, cfg, defaults}` |
| `GET /api/config?path=…` | — | `{path, value, default}`; sem `path`, o cenário inteiro |
| `PATCH /api/session` | `{"changes": {"caminho": valor, …}}` | `{version, applied}`; 400 com `details` por caminho se algo for inválido (nada é aplicado) |
| `POST /api/session/reset` | `{"paths": [...]}` ou `{}` | `{version}` |
| `POST /api/session/scenario` | `{"name": "rapido"}` | `{version, scenario}` |
| `GET /api/params` | — | parâmetros documentados com valor e padrão |
| `GET /api/scenarios?details=1` | — | `[{name, description}]` |
| `GET /api/state` | — | estado relatado pela interface aberta (abaixo) |
| `POST /api/playback` | `{"action": …, "value": …}` | `{delivered_to}` — quantas interfaces receberam |
| `GET /api/events` | — | Server-Sent Events: `config`, `command`, `ui-state`, `run` |
| `POST /api/render` | `{"camera": "linecam", "t_from_crossing": -0.1}` ou `{"t": 7.5}` | `image/jpeg`; cabeçalho `X-Sim-Meta` com veredito, folga e eventos |
| `GET /api/runs` | — | simulações em `runs/` |
| `POST /api/runs` | `{"name": "teste", "video": false}` | 202 com o job; acompanhe com `GET /api/runs/{nome}` |
| `GET /api/runs/{nome}` | — | status, etapa, resumo por algoritmo, relatório, arquivos, fim do log |
| `GET /api/runs/{nome}/files/{arquivo}` | — | o arquivo (`final.mp4`, `results.json`, `linecam.mp4`…) |
| `POST /mcp` | JSON-RPC MCP | Streamable HTTP, sem sessão |

### Ações de reprodução (`POST /api/playback`)

`play`, `pause`, `toggle`, `seek` (s absoluto), `seek_relative_to_crossing` (s em relação ao instante em que a
aeronave cruza o obstáculo), `step` (avança ou recua s), `speed` (0,05 a 1; aceita até 4), `loop`,
`select_camera` (`free`, `chase` ou o nome de uma câmera), `previews` e `frustums` (true/false).
Comandos só têm efeito com a interface aberta; a resposta diz quantas a receberam.

### Estado da interface (`GET /api/state`)

`ui_connected` diz se alguma interface relatou nos últimos 5 s. `ui` traz: `t`, `t_end`, `t_from_crossing`,
`playing`, `speed`, `loop`, `camera`, `cameras`, `aircraft` (x, y, z, V), `truth` (folga real, veredito e eventos:
estol, rotação, decolagem, cruzamento), `fps` e `gpu`.

## Exemplos

```bash
B=http://127.0.0.1:5173
curl -s "$B/api/config?path=cameras.linecam.position"
curl -s -X PATCH $B/api/session -H 'content-type: application/json' \
  -d '{"changes": {"environment.wind.speed_ms": 6, "cameras.linecam.fps": 480, "dynamics.target_clearance_m": 0.02}}'
curl -s -X POST $B/api/playback -H 'content-type: application/json' -d '{"action": "seek_relative_to_crossing", "value": -0.1}'
curl -s -X POST $B/api/render -H 'content-type: application/json' -d '{"camera": "track_b", "t_from_crossing": 0}' -o quadro.jpg
curl -s -X POST $B/api/runs -H 'content-type: application/json' -d '{"name": "vento6", "video": true}'
curl -s $B/api/runs/vento6        # repita até "status": "done"
```

## MCP

Ferramentas: `list_parameters`, `get_config`, `set_parameters`, `reset_parameters`, `list_scenarios`,
`load_scenario`, `control_playback`, `get_state`, `render_frame` (devolve a imagem), `run_simulation`, `get_run`,
`list_runs`.

**Claude Code**: o repositório tem um `.mcp.json`; abrindo o Claude Code na pasta do projeto, o servidor
`takeoff-sim` já aparece. Em outro lugar:

```bash
claude mcp add takeoff-sim -- node /caminho/para/aerodesign-takeoff-detection/sim/mcp.mjs
# ou, com o servidor já rodando, por HTTP:
claude mcp add --transport http takeoff-sim http://127.0.0.1:5173/mcp
```

**Claude Desktop / Cursor** (`mcpServers`):

```json
{ "takeoff-sim": { "command": "node", "args": ["/caminho/para/aerodesign-takeoff-detection/sim/mcp.mjs"] } }
```
