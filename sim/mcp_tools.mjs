// Ferramentas MCP do simulador. `backend` tem os mesmos métodos de createApi() (sim/api.mjs), seja no
// próprio processo (endpoint /mcp do servidor) ou via HTTP (sim/mcp.mjs, transporte stdio).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ''}` }] });
const wrap = (fn) => async (args) => { try { return await fn(args ?? {}); } catch (e) { return fail(e); } };

export function createMcpServer(backend) {
  const server = new McpServer({ name: 'aerodesign-takeoff-sim', version: '0.2.0' }, {
    instructions: [
      'Simulador de validação de decolagem de AeroDesign (obstáculo de 90 cm a 55 m, regulamento SAE BRASIL 2026).',
      'O estado é uma sessão de configuração compartilhada com a interface web: o que você muda aparece na tela de quem estiver com ela aberta.',
      'Fluxo típico: list_parameters → set_parameters → (render_frame para conferir) → run_simulation → get_run até status "done".',
      'Unidades no cenário são SI (m, s, kg, graus); list_parameters mostra também a unidade exibida na interface.',
    ].join(' '),
  });

  server.registerTool('list_parameters', {
    title: 'Listar parâmetros',
    description: 'Lista os parâmetros documentados do cenário (vento, sol, obstáculo, aeronave, ArUco, e para cada câmera posição, mira, lente, sensor, vibração e erros de calibração) com caminho, faixa válida, opções, valor atual e padrão. Os valores estão em unidades SI; `scale` converte para a unidade exibida na interface.',
    inputSchema: { filter: z.string().optional().describe('Texto para filtrar por caminho, rótulo ou grupo (ex.: "linecam", "vento", "calibração").') },
  }, wrap(async ({ filter }) => {
    let list = await backend.params();
    if (filter) { const f = filter.toLowerCase(); list = list.filter((p) => [p.path, p.alias, p.label, p.group, p.tab].some((s) => s && s.toLowerCase().includes(f))); }
    return text(list);
  }));

  server.registerTool('get_config', {
    title: 'Ler configuração',
    description: 'Lê o cenário inteiro da sessão ou um valor por caminho. Caminhos usam ponto e aceitam o nome da câmera no lugar do índice (ex.: "cameras.linecam.position", "obstacle.height_m", "dynamics.target_clearance_m"). Qualquer chave do cenário pode ser lida, não só as documentadas.',
    inputSchema: { path: z.string().optional() },
  }, wrap(async ({ path }) => text(await backend.getConfig(path))));

  server.registerTool('set_parameters', {
    title: 'Alterar parâmetros',
    description: 'Altera um ou mais valores do cenário da sessão de uma vez (tudo ou nada: se algum for inválido, nada é aplicado e a resposta diz por quê). Aceita qualquer caminho existente; os documentados têm faixa e opções validadas. A interface aberta recalcula a cena na hora.',
    inputSchema: { changes: z.record(z.string(), z.any()).describe('Mapa caminho → valor, ex.: {"environment.wind.speed_ms": 6, "cameras.linecam.fps": 480, "dynamics.target_clearance_m": 0.02}') },
  }, wrap(async ({ changes }) => text(await backend.setParameters(changes, 'mcp'))));

  server.registerTool('reset_parameters', {
    title: 'Restaurar padrões',
    description: 'Volta parâmetros aos valores do cenário carregado. Sem `paths`, restaura tudo.',
    inputSchema: { paths: z.array(z.string()).optional() },
  }, wrap(async ({ paths }) => text(await backend.resetParameters(paths, 'mcp'))));

  server.registerTool('list_scenarios', {
    title: 'Listar cenários', description: 'Lista os cenários prontos (arquivos em scenarios/) com a descrição de cada um.', inputSchema: {},
  }, wrap(async () => text(await backend.listScenarios())));

  server.registerTool('load_scenario', {
    title: 'Carregar cenário',
    description: 'Substitui a sessão por um cenário pronto (ele passa a ser o "padrão" para restaurar).',
    inputSchema: { name: z.string().describe('Nome do cenário, ex.: "rapido", "limite_falha", "vento_forte".') },
  }, wrap(async ({ name }) => text(await backend.loadScenario(name, 'mcp'))));

  server.registerTool('control_playback', {
    title: 'Controlar a interface',
    description: 'Envia um comando às interfaces web abertas: play, pause, toggle, seek (tempo absoluto em s), seek_relative_to_crossing (s em relação ao cruzamento do obstáculo), step (avança/recua s), speed (0,05 a 1), loop (true/false), select_camera (free, chase ou nome de câmera), previews e frustums (true/false).',
    inputSchema: {
      action: z.enum(['play', 'pause', 'toggle', 'seek', 'seek_relative_to_crossing', 'step', 'speed', 'loop', 'select_camera', 'previews', 'frustums']),
      value: z.union([z.number(), z.string(), z.boolean()]).optional(),
    },
  }, wrap(async ({ action, value }) => text(await backend.playback(action, value))));

  server.registerTool('get_state', {
    title: 'Estado da interface',
    description: 'Estado relatado pela interface aberta: tempo, câmera selecionada, velocidade, se está tocando, posição/velocidade da aeronave, folga real e eventos (rotação, decolagem, cruzamento), fps e GPU.',
    inputSchema: {},
  }, wrap(async () => text(await backend.getState())));

  server.registerTool('render_frame', {
    title: 'Renderizar quadro',
    description: 'Renderiza (sem interface, na GPU quando houver) a imagem de uma câmera do cenário atual num instante, com todos os efeitos de sensor. Use t_from_crossing (s em relação ao cruzamento do obstáculo, ex.: -0.1) ou t (s absoluto). Leva de 10 a 40 s. Retorna a imagem e a folga real.',
    inputSchema: {
      camera: z.string().default('chase').describe('free, chase ou o nome de uma câmera do cenário (linecam, track_a…)'),
      t_from_crossing: z.number().optional(),
      t: z.number().optional(),
    },
  }, wrap(async (args) => {
    const r = await backend.renderFrame(args);
    return { content: [
      { type: 'image', data: Buffer.from(r.image).toString('base64'), mimeType: r.mime },
      { type: 'text', text: JSON.stringify({ verdict: r.verdict, clearance_m: r.clearance_m, events: r.events }, null, 2) },
    ] };
  }));

  server.registerTool('run_simulation', {
    title: 'Rodar simulação',
    description: 'Roda a simulação completa com o cenário atual da sessão: render de todas as câmeras, os três algoritmos (câmera de linha, ArUco, sem marcador) e, se video=true, o vídeo final. Retorna na hora com o nome do job; acompanhe com get_run. Leva de 4 a 15 min numa GPU.',
    inputSchema: { name: z.string().optional().describe('Nome da pasta em runs/ (letras, números, ponto, hífen, sublinhado).'), video: z.boolean().default(false) },
  }, wrap(async (args) => text(await backend.startRun(args))));

  server.registerTool('get_run', {
    title: 'Resultado de simulação',
    description: 'Status de uma simulação (running/done/failed), etapa atual, resumo dos resultados por algoritmo (veredito, folga, erro), relatório em markdown e arquivos gerados (vídeos, JSON).',
    inputSchema: { name: z.string() },
  }, wrap(async ({ name }) => text(await backend.getRun(name))));

  server.registerTool('list_runs', {
    title: 'Listar simulações', description: 'Lista as simulações em runs/, da mais recente para a mais antiga.', inputSchema: {},
  }, wrap(async () => text(await backend.listRuns())));

  return server;
}
