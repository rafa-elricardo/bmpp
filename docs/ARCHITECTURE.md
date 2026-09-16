# BMPP — Basic Memory Policy Plugin

> **Documento canônico.** Este é o documento normativo do BMPP e vive no próprio repositório, em
> `docs/ARCHITECTURE.md`, versionado junto com o código. Não existe cópia paralela: a versão de
> trabalho da fase de projeto foi incorporada aqui e está congelada.
>
> Documentos companheiros: [`docs/COMPATIBILITY.md`](COMPATIBILITY.md) (envelope de versão BMPP ↔
> DSH, detecção e decisão de carregamento) e [`docs/DISTRIBUTION.md`](DISTRIBUTION.md)
> (desenvolvimento vs. distribuição, higiene do repositório e licença).

## Documento de arquitetura e projeto

Data: 2026-09-16 · Autor: agente DSH · Status: **revisão 3 aprovada como base — fundação criada, nenhuma implementação de política iniciada**

### Histórico de revisão

| Rev. | Data | Mudança | Aprovado por |
|---|---|---|---|
| 1 | 2026-09-16 | Projeto inicial (26 seções) | maintainer (as the architectural baseline) |
| 2 | 2026-09-16 | Local do plugin fixado em `packages/bmpp/`; modelo de configuração normalizado (`mode` × `profile`); `bmpp__classify` deixa de exigir posição de primeira chamada; escopo do MVP fixado em Basic Memory; `ask` só em `profile: strict`; defaults `mode: audit` + `profile: compat`; estado do Git registrado | maintainer |
| 5 | 2026-09-16 | **Incremento 1d implementado**: eventos duráveis `bmpp/policy` com duas formas (`pre-execute` e `recall`), append isolado do veredito, e a separação explícita entre `policyTurn` e `harnessTurn` documentada em §13.1 | maintainer |
| 4 | 2026-09-16 | **Incremento 1c implementado**: o gate foi montado sobre `tools/pre-execute`, `tools/result`, `session/disposed` e a ferramenta `bmpp__classify`; duas adaptações ao runtime real registradas em §7.4 | maintainer |
| 3 | 2026-09-16 | **BMPP passa a ser um projeto standalone** em `<workspace>/bmpp/`, com repositório Git próprio e versionamento independente; o checkout do DSH permanece clone oficial, sem fork, sem branch e sem alteração; forma de distribuição confirmada como *bundle* (`dsh.bundle`); estratégia de compatibilidade e de licença definidas; documentação arquitetural migrada para dentro do repositório do BMPP | maintainer |

**Decisões normativas da rev. 2** (o resto do documento já reflete cada uma):

- `mode = off | audit | enforce`; `profile = compat | strict`; **default `mode: audit` + `profile: compat`**; `profile` **nunca** altera `mode`.
- `bmpp__classify` pode ocorrer em **qualquer ponto** do turno — **não** precisa ser a primeira tool call.
- Turno sem classificação permanece `UNKNOWN`: **bloqueia mutações de memória, permite leituras**.
- `search` + `write` no mesmo lote: search permitido, write negado (`MEMORY_LOOKUP_PENDING_IN_BATCH`). Gate **não** vai para `tools/execute` nesta fase.
- `ask` para operações destrutivas **somente** em `profile: strict`; **nunca** em `mode: audit`.
- Guards secundários começam em `warn` (`secretPatternGuard`, `testFixtureGuard`, `overwriteRequiresRead`); `strict` pode subir para `deny`.
- Escopo do MVP: **somente ferramentas do Basic Memory**. Nada de política genérica de segurança de agente.
- Git é tratado em etapa separada, com autorização explícita, antes da Fase 1 (§25).

**Decisões normativas da rev. 3** (substituem a decisão de local da rev. 2):

- O BMPP vive em **`<workspace>/bmpp/`**, como **projeto standalone com Git próprio**. Não é um
  pacote do monorepo do DSH e não fica em `deepseek-harness/packages/`.
- O checkout do DSH é um **clone oficial** e permanece limpo: **sem fork**, **sem branch nova**,
  **sem alteração local**, **sem `git init` aninhado**.
- BMPP tem **versionamento próprio**, independente do DSH, com envelope de compatibilidade
  explícito (`BMPP 0.1.0` ↔ `DSH >= 0.1.5-rc.2 < 0.2.0`).
- A forma de distribuição é o **bundle** do DSH (`dsh.bundle.patch`), com desenvolvimento local por
  `--patch` e caminho absoluto.
- A documentação de arquitetura vive **dentro do repositório do BMPP**
  (`docs/ARCHITECTURE.md`), versionada com o código.
- Licença: **MIT** confirmada como tecnicamente adequada (análise em `docs/DISTRIBUTION.md`),
  pendente apenas da confirmação do detentor do copyright.

Base de verificação (tudo lido no código vivo nesta sessão, nada inferido):

| Componente | Versão / local |
|---|---|
| DeepSeek Harness | `0.1.5-rc.2`, checkout `<dsh-checkout>` (commit `c291e7961a`) |
| Basic Memory | `0.23.2` (via `uvx`, cache `~/.cache/uv/archive-v0/<cache-entry>/basic_memory`) |
| Perfil DSH vivo | `~/.dsh/profiles/web/` (`cordis.yml` + `cordis.patch.yml`, `patchReload: live`) |
| Notas | `$BASIC_MEMORY_ROOT` (projeto `main`), índice `$BASIC_MEMORY_HOME/` |
| Política comportamental | `~/.dsh/AGENTS.md` + `<private-memory-note>` |
| Suíte de verificação existente | `<private-research-directory>/policy_verify.py` + `policy_spec.json` (12 cenários) |

---

## 1. Resumo executivo

O BMPP é um **plugin nativo Cordis** que se registra no seam `tools/pre-execute` (gate síncrono
allow/deny/ask do registro de ferramentas) e em `tools/result` (auditoria), e que mantém uma
**state machine pequena, determinística e verificável** por sessão/turno para impor as partes
*mecânicas* da política de memória:

1. **Precondição de recall** — quando o turno foi classificado COMPLEX, nenhuma operação de
   memória que *muda estado* (`write_note`, `edit_note`, `move_note`, `delete_note`, …) é despachada
   antes de uma consulta de memória ter **concluído com sucesso** nesse turno.
2. **Gate de persistência** — quando o modo exige, uma operação de **criação** (`write_note`) exige
   uma consulta de memória prévia no mesmo turno (a versão mecânica do "procure antes de escrever"
   do Gate 3).
3. **Classificação como ato explícito do modelo** — o modelo *declara* `SIMPLE`/`COMPLEX` por uma
   ferramenta de controle `bmpp__classify` (allowlisted e sempre permitida); o plugin **nunca**
   adivinha semântica a partir do texto do usuário.
4. **Auditoria** — cada decisão allow/deny vira um evento durável `bmpp/policy` no log da sessão,
   com `reason_code` machine-readable, permitindo responder "por que esta chamada foi bloqueada?"
   sem ler chain-of-thought.

O plugin **não** classifica semântica, **não** decide o que é importante, **não** resolve
duplicação semântica, **não** substitui o Basic Memory e **não** fala com o LLM.

Principais achados de reconhecimento que moldaram o projeto:

- O seam real de pré-execução é o waterfall **`tools/pre-execute`** → `PreToolDecision =
  allow | deny | ask`; existe também o guard monotônico `ctx.tools.guard()` (só nega) e o wrapper
  `tools/execute`. **Não existe** o hook `PreToolUse` no nível do DSH — esse nome é só o ponto
  Claude Code, que o bridge mapeia para `tools/pre-execute`.
- **`PreToolDecision` não reescreve argumentos** (contrato explícito; `updatedInput` de hooks é
  parseado e ignorado). Logo o BMPP **não pode** "pré-injetar contexto de memória" na chamada; ele
  **nega** com feedback acionável e o modelo refaz.
- As **tool annotations MCP (`readOnlyHint`) não chegam ao `ToolDefinition`** do DSH
  (`ToolSchema = { name, description, parameters }` só). O BMPP **precisa** da sua própria tabela
  de classificação estática das 21 ferramentas.
- O evento durável de auditoria é viável: plugins fazem *module augmentation* de
  `SessionEventMap` e chamam `session.append(...)` — padrão já usado por `goal`, `tool-present`,
  `hooks`.
- O **read cache Redis** do Basic Memory (`basic_memory.read_cache`, TTL 300 s) **está desligado**
  nesta máquina (`redis_url: null`); portanto ele **não** explica a leitura *stale* observada antes.

---

## 2. Avaliação do estado atual

### 2.1 O que já existe e funciona

- Integração MCP stdio (`mcp-basic-memory`) publicando 21 ferramentas `mcp__basic-memory__*`.
- Política comportamental em 4 gates (`~/.dsh/AGENTS.md`), com rationale na nota
  `Instructions/DSH Memory Policy`.
- Suíte de verificação **mecânica** externa: `policy_verify.py` lê o log da sessão
  (`session.v3.jsonl.zstd`) e avalia 12 cenários. Ela já prova *post hoc* que a política dispara;
  ela não impede nada em tempo real.

### 2.2 O limite real do estado atual

A política é **obrigação do modelo**, não invariante do runtime. O próprio
`memory-policy-implementation.md` (limitação nº 1) registra: "garantia dura exigiria um plugin do
DSH". O experimento T1/T1b mostra o ponto exato: com texto suave o agente foi direto ao `bash` e
nunca buscou memória; o endurecimento lexical ("o PRIMEIRO tool call DEVE ser `search_notes`")
passou a disparar — mas continua sendo *comportamento*, não *enforcement*.

### 2.3 Defeitos mecânicos conhecidos hoje

| # | Defeito | Evidência |
|---|---|---|
| D1 | Nada impede uma escrita de memória antes da consulta obrigatória | política é textual |
| D2 | `[test-fixture]` vazou para dentro de notas de projeto reais (`Example Topic Decision`, `Example Project`) | notas arquivadas em `archive/policy-tests/**` |
| D3 | Permalinks duplicados (`-1`/`-2`) só são detectados por inspeção manual do modelo | `AGENTS.md` Gate 3.5 |
| D4 | Nenhum registro estruturado de allow/block: a auditoria é arqueologia de log de sessão | `policy_verify.py` reimplementa a leitura |
| D5 | "Primeira ferramenta = `search_notes`" é frágil: não distingue leitura de escrita, não cobre paralelismo, não define "consulta concluída" | ver §6 |
| D6 | Sem classificação durável: a classificação SIMPLE/COMPLEX existe só no texto do modelo | `AGENTS.md` Gate 1 |

---

## 3. Extension points reais encontrados no DSH/Cordis

Todos verificados no código. Nada aqui é inventado.

### 3.1 Seams de ferramenta (`packages/core/tools/src/index.ts`)

Pipeline documentado (`docs/tool-execution-pipeline.md`, `packages/core/tools/README.md`):

```
snapshot/freeze args  →  tools/pre-execute  →  ctx.tools.guard()  →  tools/execute
                      →  body  →  tools/post-execute  →  finalizeContent  →  tools/result
```

| Seam | Assinatura real | Pode negar? | Pode reescrever args? | Uso no BMPP |
|---|---|---|---|---|
| `tools/pre-execute` | `(exec: ToolExecution, next) => Promise<PreToolDecision>` | **sim** (`{kind:'deny', reason}`) | **não** | gate principal |
| `ctx.tools.guard(fn)` | `(exec) => string \| undefined` | **sim, monotônico** | não | cinto de segurança para invariantes que não podem ser "ressuscitados" por outra linha |
| `tools/execute` | `(exec, next) => Promise<ToolExecutionResult>` | não (substitui resultado) | só `signal` | **não** usar para o gate (ver §6.4) |
| `tools/post-execute` | `(exec, result, next) => Promise<PostToolDecision>` | sim (`block` + `feedback`) | result | não necessário no MVP |
| `tools/result` | `(exec, result) => undefined` (emit) | não | não | auditoria de resultado |

Fatos decisivos:

- `PreToolDecision` é união fechada: `{kind:'allow'} | {kind:'deny', reason} | {kind:'ask', reason?}`.
  O JSDoc exclui explicitamente reescrita de input.
- `deny` materializa `content: [{type:'text', text: 'Error: <reason>'}]`, `isError: true`,
  `error.message = reason` — **o modelo recebe o texto do reason**. Esse é o canal de feedback.
- Ordem: `tools/pre-execute` roda **antes** da materialização; o `agent-loop` já anexou `tool/call`
  ao log. `ToolRuntime.prepareExecution` roda o waterfall para todas as chamadas do lote **antes**
  do dispatch (ver §6.4).
- Escopo: os eventos são *scope-filtered* por `exec.agent` (`packages/core/scope`), então um
  listener global vê todas as chamadas, mas recebe o `agent` correto em cada uma.
- `ctx.tools.guard()` é registrado por escopo e compõe monotonicamente: **um guard não pode ser
  revertido por um listener posterior** (`subagent-in-process-driver` usa exatamente isso).

### 3.2 Ciclo de vida do plugin (Cordis)

- Formas válidas: função `(ctx, config)`, classe `(ctx, config)`, objeto `{ apply(ctx, config) }`.
  Não existe `define()` no Cordis nativo — `define` é só da ferramenta de plugin dinâmico.
- Módulo de plugin usa **named exports** `name`, `inject`, `Config`, `apply`
  (padrão de `packages/skill/skill-filesystem/src/index.ts`). Serviços fazem *default export* da
  classe.
- `Config` é um schema **zod** validado por fiber; defaults via `.default(...)`.
- Todo efeito colateral tem disposer: `ctx.on(...)` devolve disposer, e
  `this.layers.effect(ctx, ...)` é o padrão de registro do runtime.
- Composição: arquivo raiz `cordis.yml` (no perfil: `$DSH_HOME/profiles/web/cordis.yml`),
  com camadas de patch (`cordis.patch.yml`) aplicadas por `applyEntryPatches` (`insert`, `disable`,
  substituição por `id`).
- Resolução de módulo (`vendor/loader/src/config/tree.ts:145`): `cordis:*` → builtin; specifier
  começando com `.` → `new URL(name, ctx.baseUrl)`; qualquer outro → `import(name)` (bare specifier
  resolvido a partir do módulo do loader). `ctx.baseUrl` é o diretório do `cordis.yml` (perfil).

### 3.3 Contexto e estado da sessão

| Necessidade | API real |
|---|---|
| Injetar contexto no modelo | `agent.inject(UserMessage)`; `agent.steer(UserMessage)`; `SystemPrompt.section/context`; `agent/pre-step` (waterfall com `PreStepDecision`) |
| Log durável da sessão | `agent.session.append(type, data)` — `SessionEventMap` é *merge-extensible* |
| Evento de auditoria próprio | `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'bmpp/policy': ... } }` |
| Identidade da chamada | `exec.callId`, `exec.rootCallId`, `exec.name`, `exec.arguments`, `exec.agent`, `exec.signal` |
| Observar resultado | `tools/result` (emit, listener contido) |
| Config do plugin | `Config` (zod) por linha de composição |

### 3.4 Logging e auditoria

`ctx.logger` existe no contexto; o caminho **estruturado e durável** é `session.append`, porque
persistência, replay e as ferramentas de sessão já entendem o log. Para auditoria legível fora do
DSH, o verifier existente (`zstd -dc` + JSON por linha) já sabe ler `session.v3.jsonl.zstd`.

### 3.5 Infraestrutura de testes

- Vitest na raiz, com `vite-tsconfig-paths` mapeando para **source** (`src/`), não `lib/`.
- Padrão de teste de plugin de política já existe e é exatamente o necessário:
  `packages/core/agent-loop/tests/interception.spec.ts` — constrói um `Context`, monta
  `LlmRuntime`, `SessionStore`, `SystemPrompt`, `ToolRuntime`, `AgentRegistry`, `AgentLoop`, injeta
  um `MockAdapter` com respostas roteirizadas (`toolCallResponse`, `textResponse`) e verifica o log
  da sessão. Contém o caso "deny short-circuits dispatch into an isError result the model sees".
- `packages/test-support/agent-loop-testkit` fornece o kit de loop/agente.
- Fixture de ferramenta: `defineContentToolFixture` de `@deepseek-ai/dsh-tools`.

---

## 4. Avaliação da integração atual do Basic Memory

### 4.1 Nomes reais das ferramentas (21, lidos de `<private-research-directory>/tools.json`)

Prefixo model-facing: `mcp__basic-memory__` (`publicToolName(serverName, rawName)` em
`packages/mcp/mcp-client/src/tools.ts`). O bridge **não** propaga
`tool.annotations.readOnlyHint` para o `ToolDefinition`; a tabela abaixo é, portanto, a **fonte de
verdade que o BMPP precisa internalizar**:

| Ferramenta | `readOnlyHint` | `destructiveHint` | muta estado? |
|---|---|---|---|
| `search_notes` | true | false | não |
| `search` | true | false | não |
| `build_context` | true | false | não |
| `recent_activity` | true | false | não |
| `read_note` | true | false | não |
| `read_content` | true | false | não |
| `view_note` | true | false | não |
| `list_directory` | true | false | não |
| `list_memory_projects` | true | false | não |
| `list_workspaces` | true | false | não |
| `fetch` | true | false | não |
| `basic_memory_diagnostics` | true | false | não |
| `schema_infer` | true | false | não |
| `schema_validate` | true | false | não |
| `schema_diff` | true | false | não |
| `write_note` | false | **true** | **sim** |
| `edit_note` | false | **true** | **sim** |
| `delete_note` | false | **true** | **sim** |
| `delete_project` | false | **true** | **sim** |
| `move_note` | false | false | **sim** |
| `create_memory_project` | false | false | **sim** |

### 4.2 Consistência e cache (Questão 11)

Achados verificados:

- `basic_memory.read_cache` é um cache de leitura **Redis**, opcional
  (`read_cache/lifecycle.py`: `open_redis_read_cache(redis_url)` devolve `None` quando
  `redis_url` é vazio). Config viva: `"redis_url": null` → **cache desligado**.
- Política do cache: `READ_CACHE_TTL_SECONDS = 300`, `SEARCH_READ_CACHE_TTL_SECONDS = 30`,
  chaves por *generation* + digest canônico (`read_cache/keys.py`, prefixo `bm:read:v1`).
- A invalidação por mutação é explicitamente **best-effort**: se o Redis estiver indisponível, a
  mutação já commitada **não** falha — "cached values may remain reachable until TTL expiry"
  (`read_cache/invalidation.py`). Ou seja: **mesmo habilitado, o cache não é linearizável**.
- O `McpContainer` só instala o cache se o Redis estiver configurado (`mcp/server.py:98`).

Conclusão: **o cache Redis não é a causa da leitura stale observada** (ele está desabilitado). A
observação anterior (overwrite → `read_note` imediato com conteúdo antigo, com o disco já correto)
tem de ser atribuída à camada de leitura da própria ferramenta MCP (montagem da resposta a partir
do snapshot da entidade / janela de indexação), não a um cache de resposta do DSH — o cliente MCP
do DSH **não** cacheia (`callToolUncached` faz `client.request` direto, sem memoização).

Recomendação: **documentar como limitação de consistência, não contornar**. Concretamente:

- O BMPP **não** deve usar `read_note` como verificação de escrita. A verificação de escrita usa o
  **retorno da própria operação** (`write_note`/`edit_note` devolvem permalink/`file_path`).
- O teste 13 da suíte (§15.2) deve afirmar a **realidade verificável**: "um `read_note` imediatamente
  após `overwrite` **pode** devolver conteúdo anterior; o plugin não reage a isso, e nenhuma
  escrita duplicada é emitida".
- Não resolver agora. Se e quando virar dor real, o caminho correto é investigar a camada de
  leitura do servidor (não o DSH), e a decisão é do usuário (§24, Q5).

### 4.3 O que a integração dá de graça ao BMPP

- Annotations MCP declarativas e corretas para as 21 ferramentas — base da tabela de classificação.
- Erros MCP viram resultado `isError` normalizado (`throw` → `toolErrorResult`), detectável no
  `tools/result` sem inspecionar texto.
- Timeout configurável por linha (`toolCallTimeoutMs: 120000`) — o BMPP **não** precisa de timeout
  próprio; `search_notes` que estoura vira erro e conta como "consulta falhou".
- O supervisor `dsh-mcp-client` reconecta sozinho; indisponibilidade é transitória e observável.

---

## 5. Divisão de responsabilidades

```
                         ┌──────────────────────────────────────────┐
   turno do usuário ───▶ │ DeepSeek Harness (agent-loop, tools)     │
                         └───────────────────┬──────────────────────┘
                                             │ tools/pre-execute
                                             ▼
                         ┌──────────────────────────────────────────┐
                         │ BMPP (plugin Cordis nativo)              │
                         │  · state machine por (sessão, turno)     │
                         │  · gates mecânicos allow/deny            │
                         │  · eventos de auditoria bmpp/policy      │
                         │  · NUNCA julga semântica                 │
                         └───────────────────┬──────────────────────┘
                                             │ allow
                                             ▼
                         ┌──────────────────────────────────────────┐
                         │ Basic Memory MCP (stdio) → Basic Memory  │
                         │  armazenamento e recuperação             │
                         └──────────────────────────────────────────┘
```

| Responsabilidade | Modelo | BMPP | Basic Memory |
|---|---|---|---|
| Classificar turno SIMPLE/COMPLEX | **decide** (declara via `bmpp__classify`) | registra, não julga | — |
| Consultar memória antes de tarefa complexa | **executa** a consulta | impõe a **precondição** | serve os dados |
| Escolher o que merece ser persistido | **decide** | — | — |
| Escolher editar vs. criar nota | **decide** | impõe "buscar antes de criar" quando configurado | — |
| Detectar duplicata **semântica** | **decide** | — | — |
| Detectar duplicata **mecânica de path/permalink** | — | **detecta e reporta** (não corrige) | expõe permalink/path |
| Decidir se memória está desatualizada | **decide** (Gate 2) | — | — |
| Permitir/bloquear a chamada | — | **decide e impõe** | — |
| Guardar o conhecimento | — | — | **armazena** |
| Provar que a política foi respeitada | — | **emite auditoria**; testes provam | — |

Regra de ouro do projeto: **o BMPP só afirma o que consegue provar mecanicamente**. Se um
invariante depende de julgamento, ele permanece texto (soft policy) e o plugin no máximo o
*observa* para auditoria.

---

## 6. Arquitetura proposta para o BMPP

### 6.1 Forma do pacote

Plugin Cordis nativo, *named exports*, sem serviços próprios:

```
export const name = 'bmpp'
export const inject = ['tools']          // hard dependency no ToolRuntime
export const Config = z.object({ ... })  // §13.3 (modelo normalizado mode × profile)
export function apply(ctx, config) { ... }
```

`apply` registra:

1. `ctx.tools.register(classifyTool)` — ferramenta de controle `bmpp__classify` (§6.2).
2. `ctx.on('tools/pre-execute', gate)` — gate principal.
3. `ctx.on('tools/result', auditResult)` — auditoria do desfecho (só resultado, não conteúdo).
4. `ctx.on('agent/session-start', ...)` / `session/event` para reset de estado.
5. `ctx.on('dispose', ...)` — via disposers automáticos do `ctx`.

Nada mais. Sem serviço novo, sem persistência própria, sem chamada a LLM.

### 6.2 Declaração de classificação (Questão 5)

**Decisão de projeto: o modelo declara, o plugin impõe.** Justificativa em §6.3.

O modelo chama a ferramenta **`bmpp__classify`**, registrada pelo
próprio BMPP:

```js
// schema (JSON Schema, como qualquer ToolDefinition)
{
  type: 'object',
  properties: {
    task:      { type: 'string', enum: ['simple', 'complex'] },
    rationale: { type: 'string', description: 'one short line; never chain-of-thought' }
  },
  required: ['task']
}
```

- É uma ferramenta **nativa do BMPP**, não do MCP, e por isso o nome `bmpp__classify` é estável e
  não depende do servidor.
- A chamada é **registrada no log durável** (`tool/call` + `tool/result`), o que torna a
  classificação auditável e testável mecanicamente — resolve D6.
- Ela é **sempre permitida** (não está sujeita ao gate).
- **Ela NÃO precisa ser a primeira tool call do turno.** Pode ocorrer em qualquer ponto, desde que
  antes de uma operação que muda estado. Ler um arquivo, inspecionar o repositório ou rodar um
  comando de leitura antes de classificar é legítimo e não é violação.
- Repetir `bmpp__classify` no mesmo turno é permitido e **a última declaração vence** (auditado com
  `reclassified: true`) — o modelo pode refinar a classificação ao descobrir o escopo real.
- O `rationale` é opcional e curto; **não é chain-of-thought** — é um rótulo de auditoria, no
  mesmo espírito do "name the classification in your first sentence" que a política já exige.

### 6.3 Comparação das quatro possibilidades (Questão 5)

| Opção | Mecanismo | Prós | Contras | Veredito |
|---|---|---|---|---|
| **A. Modelo declara** | ferramenta `bmpp__classify` | determinístico para o plugin; auditável; o julgamento fica com quem tem contexto; testável; não há falso COMPLEX silencioso | depende de o modelo chamar (mitigado por: default = COMPLEX, §13) | **adotada** |
| B. Metadados do ciclo de vida | nenhuma classificação existe hoje no Harness: `agent/session-start` traz só `source`; `turn/start` traz só `turn`; `agent/pre-step` traz `messages/turn/step`. Não há campo semântico | zero cooperação do modelo | não existe API — inventá-la seria forçar a arquitetura | **rejeitada** (não existe) |
| C. Inferência mecânica | regex no texto do usuário (verbos, nomes próprios) | zero cooperação | é exatamente a inferência semântica que o plugin **não** pode fingir fazer; frágil nos dois sentidos (falsos COMPLEX e, pior, falsos SIMPLE); ilegível para o modelo | **rejeitada** como base; aceitável apenas como *default* conservador |
| **D. Híbrida** | A + default conservador quando não há declaração | melhor dos dois: decisão explícita quando existe, e nunca "libera por omissão" | um turno sem declaração paga uma negação/`ask` | **adotada** |

**Híbrida concreta:**

- Se o modelo declarou `simple` → gate **inativo** no turno.
- Se declarou `complex` → gate **ativo**.
- Se **não** declarou → `classification = unknown` (o estado inicial do turno) e o gate trata como
  **complex** (fail-closed conservador): **mutações de memória ficam bloqueadas e leituras
  continuam permitidas**, com `reason_code = CLASSIFICATION_REQUIRED` dizendo exatamente o que
  fazer.
- A declaração explícita é **obrigatória para liberar um turno como SIMPLE** — não há outro caminho
  para desligar o gate.

O plugin **nunca** lê o texto do usuário para decidir. Isso honra o princípio fundamental do
projeto.

Observação importante de honestidade arquitetural: `bmpp__classify` é uma ferramenta **a mais** no
prompt. Ela é pequena e barata, mas é cooperação — quem não a chama é bloqueado, não adivinhado.
Isso é deliberado.

### 6.4 Gates, ordem e paralelismo

Fatos que definem o desenho:

- O `agent-loop` chama `prepareExecution` de todas as chamadas do lote **antes** de despachar
  (`packages/core/agent-loop/src/tool-calls.ts`: "Ordered pre-execute may await; only
  dispatch/body overlaps"). O comentário do módulo confirma: "parallel calls use a bounded rolling
  pool and are reclassified before start".
- Portanto, no instante do `tools/pre-execute` de uma chamada do lote, **nenhuma** outra chamada do
  mesmo lote executou seu corpo ainda.

Consequência: um lote que contenha `search_notes` **e** `write_note` **não pode** satisfazer o gate
para a escrita — a busca ainda não concluiu quando a escrita é avaliada. O BMPP então:

- **permite** a consulta (read-only);
- **nega** a mutação com `reason_code: MEMORY_LOOKUP_PENDING_IN_BATCH` e uma instrução explícita:
  "a consulta de memória está neste mesmo lote e ainda não retornou; aguarde o resultado e repita a
  escrita em uma chamada nova (não em paralelo)".

Isso é conservador, determinístico, recuperável em um passo e **não trava o Harness**. A
alternativa (decidir em `tools/execute`) foi considerada e rejeitada no MVP: `tools/execute`
substitui resultado em vez de negar, então o modelo veria um erro de resultado em vez de uma
correção de pré-condição, e a mensagem ficaria menos acionável. Fica registrada como variação
possível em §24 (Q4) — decisão da rev. 2: **não** nesta fase.

Precedência dos gates (primeiro que casar vence):

```
G0  ferramenta do próprio BMPP (bmpp__*)           → allow (sempre)
G1  BMPP disabled / turno sem agente               → allow (no-op)
G2  classificação do turno = simple                → allow
G3  ferramenta read-only                           → allow + marca read_ok
G4  consulta de memória                            → allow + abre lookup
G5  mutação de memória, classificação unknown      → deny CLASSIFICATION_REQUIRED
G6  mutação de memória, lookup pendente no lote     → deny MEMORY_LOOKUP_PENDING_IN_BATCH
G7  mutação de memória, lookup ausente/falhou       → deny MEMORY_LOOKUP_REQUIRED / _FAILED
G8  criação de nota, gate de busca-antes-de-criar   → deny CREATE_REQUIRES_SEARCH
G9  mutação de memória, lookup ok                   → allow (+ observação de duplicata mecânica)
G10 qualquer ferramenta fora do Basic Memory         → allow (fora do escopo do MVP)
```

**Nota de escopo (normativa).** Os gates valem **exclusivamente** para ferramentas do Basic Memory
(`mcp__basic-memory__*`). `bash`, `edit`, `write`, `terminal`, `present` e qualquer outra ferramenta
de mutação **não** são bloqueadas, observadas ou classificadas pelo BMPP no MVP. O BMPP **não** é e
não será, nesta fase, uma política genérica de segurança de agente.

Consequência de projeto: **não existe** opção de configuração para ampliar o escopo (nada de
`gateScope`). Uma extensão futura exigiria uma decisão nova, com seu próprio documento — não um
valor a mais no schema atual.

---

## 7. State machine

Escopo: **por sessão**, com sub-estado **por turno**. Motivo em §11.

### 7.1 Estados

```
                     ┌────────────────┐
   turn/start ──────▶ │ UNKNOWN        │  (default conservador: trata como complex)
                     └───────┬────────┘
   bmpp__classify em        │   (QUALQUER ponto do turno, antes de uma mutação de memória)
   qualquer momento ────────┤
        ┌────────────────────┴────────────────────┐
        │ simple                                  │ complex
        ▼                                         ▼
  ┌───────────┐                          ┌────────────────────┐
  │ SIMPLE    │  gate off                │ RECALL_REQUIRED    │
  └───────────┘                          └─────────┬──────────┘
                                                   │ tools/pre-execute
                                                   │ de search_notes (allow)
                                                   ▼
                                         ┌────────────────────┐
                                         │ RECALL_IN_FLIGHT   │
                                         └─────────┬──────────┘
                              tools/result           │
                     ┌──────────────┬────────────────┴─────────────┐
                     │ sucesso      │ isError                     │ vazio (0 resultado)
                     ▼              ▼                             ▼
             ┌──────────────┐  ┌──────────────┐            ┌──────────────────┐
             │ RECALL_OK    │  │ RECALL_FAILED│            │ RECALL_EMPTY     │
             │ gate aberto  │  │ gate fechado │            │ gate ABERTO      │
             └──────────────┘  └──────┬───────┘            └──────────────────┘
                                      │ nova tentativa de search_notes
                                      └──────────▶ RECALL_IN_FLIGHT
```

Estados terminais do turno: `SIMPLE` (gate off), `RECALL_OK`, `RECALL_EMPTY`, `RECALL_FAILED`
(reabrível por nova tentativa).

### 7.2 Definição precisa de "a consulta de memória foi concluída" (Questão 6)

Uma consulta de memória **conta como satisfeita** quando, no turno corrente:

1. a ferramenta chamada pertence a `readTools.search` (default: `search_notes`, `search`,
   `build_context`); **e**
2. o evento `tools/result` correspondente chegou com `isError` **falso**; **e**
3. o resultado não é um erro de protocolo/MCP.

- Sucesso **com zero resultados** satisfaz o gate (`RECALL_EMPTY` → gate aberto). A política já diz
  que resultado vazio é resposta válida; o plugin não pune honestidade.
- Falha (`isError: true`) **não** satisfaz. O modelo pode tentar de novo; uma tentativa bem-sucedida
  transita para `RECALL_OK`.
- `RECALL_FAILED` é fail-closed apenas para **mutações de memória**; leituras continuam permitidas.
- "Concluída" nunca significa "bem-sucedida em encontrar algo" — significa "o resultado voltou".

### 7.4 Adaptações exigidas pelo runtime real (incremento 1c)

Duas premissas deste capítulo não têm suporte direto no runtime e foram adaptadas. Ficam
registradas aqui para que a divergência entre o desenho e o código seja explícita.

**(a) `RECALL_EMPTY` não é alcançável pelo adaptador real.** O servidor Basic Memory não declara
`outputSchema` para `search_notes` (`outputSchema: null`), então o bridge MCP entrega apenas
`McpResult = { content, structuredContent? }` — blocos de conteúdo, sem campo estruturado de
contagem. O único sinal confiável é `isError`. A integração mapeia:

| Resultado | Sub-estado |
|---|---|
| `isError === false` | `succeeded` / `ok` → gate **aberto** |
| `isError === true` | `failed` → gate **fechado** |
| vazio com sucesso | indistinguível de `ok` → **tratado como `ok`** |

Isto **não altera a política**: §7.2 já determinava que todo resultado sem erro satisfaz o gate,
inclusive vazio. `RECALL_EMPTY` era observação de auditoria, nunca um gate. O tipo `empty` permanece
na state machine e nos testes, porém **não-alcançável** a partir do pipeline. Uma inferência de
vazio exigiria interpretar texto de `ContentBlock`, o que este projeto recusa fazer. A distinção
volta se — e quando — o servidor passar a expor um sinal estruturado.

**(b) Não existe evento observável de início de sessão.** O sinal que §7.3 atribuía a
`agent/session-start` é um evento de **agente**, não do store de sessões, e não serve como marco de
criação da sessão. Adaptação implementada: **inicialização preguiçosa** do estado na primeira
chamada de ferramenta da sessão, mais reset por **avanço do turno** (`turnBoundary.lastTurn`), o que
produz o mesmo efeito — todo turno novo nasce `UNKNOWN`. O descarte do estado por sessão usa
`session/disposed`, que é um sinal real e não escopado.

### 7.3 Transições e reset

| Gatilho | Efeito |
|---|---|
| `agent/session-start` | inicializa estado da sessão: `turnId = 0`, `classification = none`, reset |
| `turn/start` (via `session/event`) | **reset do turno**: `classification = none`, `recall = idle`, limpa bloqueios; incrementa `turnId` |
| `bmpp__classify` (`simple`) — em qualquer ponto do turno | `classification = simple`; se nada mutou ainda, o gate nunca chegou a fechar |
| `bmpp__classify` (`complex`) — em qualquer ponto | `classification = complex`; se `recall = idle`, entra em `RECALL_REQUIRED` |
| `bmpp__classify` repetido | vale a **última** declaração; evento com `reclassified: true` |
| `tools/pre-execute` de read tool | se complex/unknown: `recall = in_flight`; allow |
| `tools/result` da busca | `ok` → `RECALL_OK`; `isError` → `RECALL_FAILED`; sucesso vazio → `RECALL_EMPTY` |
| `tools/pre-execute` de mutação | avalia gate; nega ou permite (registra `blocked_count`, `reason_code`) |
| fim do turno | estado de turno descartado (o próximo `turn/start` reseta) |
| reload/restart do plugin | estado em memória perdido → turno volta a `UNCLASSIFIED` → **fail-closed** |

Reset "correto" é verificável: a auditoria emite `bmpp/policy` com `phase: 'turn.reset'` em cada
`turn/start`, e o teste 8 (§18) afirma que após o reset o gate volta a fechar.

---

## 8. Matriz de interceptação de ferramentas (Questão 9)

Prefixo omitido: todas as MCP são `mcp__basic-memory__<nome>`. O BMPP casa por **sufixo do nome
público** mais o namespace do servidor (`mcp__basic-memory__`), ambos vindos de `Config`.

| Ferramenta | Finalidade | Relevância para a política | Imposição mecânica? | Violação possível | Comportamento do BMPP |
|---|---|---|---|---|---|
| `search_notes` | busca (hybrid/semantic/title) | **satisfaz o recall** | não precisa impor (é permitida) | nenhuma | allow; abre `RECALL_IN_FLIGHT`; `tools/result` fecha o gate |
| `search` | busca full-text | satisfaz o recall (configurável) | não | idem | allow; idem |
| `build_context` | contexto por grafo `memory://` | satisfaz o recall (configurável) | não | idem | allow; idem |
| `recent_activity` | atividade recente | **não** satisfaz por default (não é busca pelo assunto) | — | usar `recent_activity` como desculpa para pular o recall | allow como leitura; **não** abre/fecha o gate |
| `read_note` | ler nota | leitura pura | não | idem | allow; não satisfaz o recall isoladamente |
| `read_content` | ler conteúdo bruto | leitura pura | não | idem | allow |
| `view_note` | renderizar nota | leitura pura | não | idem | allow |
| `list_directory` | listar pasta | leitura pura | não | idem | allow |
| `list_memory_projects` | listar projetos | leitura pura | não | idem | allow |
| `list_workspaces` | listar workspaces | leitura pura | não | idem | allow |
| `fetch` | buscar doc por id | leitura pura | não | idem | allow |
| `basic_memory_diagnostics` | saúde | leitura pura | não | idem | allow |
| `schema_infer` / `schema_validate` / `schema_diff` | schema | leitura pura | não | idem | allow |
| `write_note` | criar/sobrescrever | **mutação** | **sim** | criar nota sem ter buscado antes → duplicata | deny se recall não satisfeito (complex/unknown); em `overwrite: true`, exige leitura prévia da nota no turno (opcional, §13) |
| `edit_note` | editar nota existente | **mutação** | **sim** | editar sem contexto → conflito com histórico | deny se recall não satisfeito |
| `move_note` | mover nota | **mutação** | **sim** | arquivar/mover sem recall | deny se recall não satisfeito |
| `delete_note` | apagar | **mutação destrutiva** | **sim**, e é o caso mais crítico | apagar sem contexto | deny se recall não satisfeito; em `strict`, `ask` (aprovação) |
| `create_memory_project` | criar projeto | mutação de configuração | **sim** (mesma família) | criar projeto por engano | deny se recall não satisfeito |
| `delete_project` | apagar projeto | mutação destrutiva | **sim** (crítica) | destruição em massa | deny se recall não satisfeito; em `strict`, `ask` |
| **qualquer outra** (`npm__*`, `bash`, `edit`, `write`, `present`, …) | fora do Basic Memory | fora do escopo no MVP | não (ver §6.4) | — | allow; auditado em nível `off`/`warn` conforme `Config` |

Regra de robustez: **ferramenta de memória desconhecida** (apareceu no namespace mas não está em
nenhuma das listas) é tratada como **mutação** — fail-closed. Isso é importante porque o servidor
publica 21 ferramentas hoje e pode publicar mais amanhã; a lista é *fail-closed por omissão*, não
*fail-open*.

---

## 9. Matriz HARD vs SOFT POLICY (Questão 4)

| # | Regra da política atual | Runtime (HARD)? | Por quê | Sinal concreto que permite impor | O que o plugin **não** sabe | Quando a imposição não é possível |
|---|---|---|---|---|---|---|
| 1 | Classificar cada turno SIMPLE/COMPLEX | **não impõe; registra** | o julgamento é semântico | o modelo declara via `bmpp__classify` | se a declaração é *verdadeira* | declaração ausente → trata como COMPLEX (conservador) |
| 2 | "Primeira ferramenta = `search_notes`" | **substituída** por precondição | frágil e literal (ver §10) | ordem de `tools/pre-execute` + `tools/result` | nada | — |
| 3 | Memória é contexto, não autoridade | **não impõe** (é conceitual) | não há sinal mecânico de "autoridade" | — | todo o julgamento | permanece 100% texto; o plugin só ajuda a **não** tratar memória como autoridade (não a torna fonte de verdade) |
| 4 | Persistir só o que importa | **não impõe** | julgamento semântico puro | — | o conteúdo e o significado | permanece texto |
| 5 | Editar em vez de duplicar | **imposição parcial** | a parte mecânica é "buscar antes de criar" e "colisão exata de path/permalink" | `write_note` com `overwrite` + retorno de permalink; nome do arquivo | se duas notas dizem a mesma coisa | duplicata **semântica** permanece com o modelo |
| 6 | Não persistir transitório/segredos | **detecção, não prevenção** | "isto é um segredo" é julgamento | padrões de alta confiança no **argumento** da chamada | se um valor é segredo real | detecta só padrões óbvios (token, `sk-`, `Bearer`, chave privada); heurística, **não** proteção completa contra secrets | default `warn`; `profile: strict` pode subir para `deny` |
| 7 | Consultar antes de agir em tarefa complexa | **SIM — núcleo do BMPP** | o sinal é puramente mecânico: houve ou não um `tools/result` bem-sucedido de busca neste turno | ordem dos eventos do pipeline | nada | se o pipeline não emitir (falha de infraestrutura), fail-closed com `warn` |
| 8 | Nota existente é contexto histórico | **não impõe** | julgamento | — | tudo | permanece texto (Gate 2) |
| 9 | Arquivar, nunca apagar | **imposição parcial** | `delete_note` é mecanicamente identificável | nome da ferramenta + argumento | se aquilo é "engano da sessão" | `profile: compat` → gate normal, sem `ask`; `profile: strict` → `ask` (aprovação humana) para `delete_note`/`delete_project`; `mode: audit` → **nunca** `ask` |
| 10 | Checar permalink `-1`/`-2` | **SIM, observação** | o retorno traz o permalink e é comparável | `tools/result` + parsing do valor | a intenção por trás | detecta e **emite aviso de auditoria**; nunca reescreve nem apaga por conta própria |
| 11 | Rótulo `[test-fixture]` só em fixtures | **SIM, detecção** | é literalmente string matching | argumentos de `write_note`/`edit_note` e caminho alvo | se a nota é "de projeto" | default `warn`; `profile: strict` pode bloquear (`deny`) `[test-fixture]` fora de um diretório de testes declarado |
| 12 | Não escrever duas vezes pelo mesmo fato | **SIM** | estado do turno + identidade da nota | `(tool, path, operação)` repetidos no mesmo turno | se são fatos diferentes | bloqueia repetição idêntica no mesmo turno com `DUPLICATE_WRITE_SAME_TURN` |

Resumo do princípio: **o BMPP impõe exatamente as regras cujo sinal é um evento do runtime (ordem de
chamadas, sucesso/falha, nome da ferramenta, argumento literal). Tudo que exige julgar significado
permanece texto** — e o documento é explícito sobre isso para não criar falsa confiança.

---

## 10. A regra da "primeira ferramenta" (Questão 6)

### 10.1 A regra literal é a formulação errada?

Não exatamente errada — **subespecificada**. Ela foi eficaz como instrução textual (T1b), mas como
invariante de runtime ela tem sete buracos, listados abaixo com a resposta do projeto.

**(a) `search_notes` precisa literalmente ser a primeira chamada?**
Não. O que importa é que **nenhuma operação relevante aconteça antes do recall**. O BMPP formula a
regra como **precondição** — "mutação de memória exige recall concluído" — em vez de posição
ordinal. Uma posição ordinal é uma condição *mais forte* que a política precisa e por isso quebra em
casos legítimos (ex.: o modelo precisa classificar primeiro; precisa ler uma nota que já tem em
contexto; precisa ler `AGENTS.md`).

**(b) Ferramentas de leitura somente poderiam ocorrer antes?**
Sim, e devem. Leitura não destrói nada e frequentemente é o que torna a busca melhor (o modelo lê o
arquivo e então sabe o que perguntar). O BMPP permite **toda** ferramenta read-only antes do recall.
Isso remove a classe de falso bloqueio mais comum.

**(c) Ferramentas internas / chamadas obrigatórias do Harness precisam ser exceções?**
Sim: `bmpp__classify` (controle do próprio BMPP), e qualquer ferramenta declarada em
`exemptTools` no config. Sem isso, o gate se autobloqueia. Também entram aqui ferramentas de
progresso/UI que não mudam estado.

**(d) Chamadas usadas exclusivamente para classificação devem ser permitidas?**
Sim, por construção: `bmpp__classify` é a única e é sempre permitida (G0).

**(e) Execução paralela de ferramentas?**
Tratada explicitamente (§6.4). O lote tem `pre-execute` ordenado antes de qualquer corpo; então
`search_notes` + `write_note` no mesmo lote **não** satisfaz o gate. O BMPP nega a mutação com
`MEMORY_LOOKUP_PENDING_IN_BATCH` e diz ao modelo para repetir em chamada separada. Determinístico e
recuperável.

**(f) E se `search_notes` falhar?**
`isError: true` → não satisfaz. Estado `RECALL_FAILED`. Motivo: uma busca que falhou não é recall.
O modelo pode tentar de novo (nova chamada é permitida), e uma tentativa bem-sucedida abre o gate.
O erro devolvido ao modelo é `MEMORY_LOOKUP_FAILED` com a instrução de repetir a consulta.

**(g) E se retornar zero resultados?**
**Satisfaz.** `RECALL_EMPTY` abre o gate. A política já declara que vazio é resposta válida, e
punir o vazio ensinaria o modelo a inventar resultados. A auditoria registra
`recall_outcome: 'empty'`, o que torna isso verificável.

**(h) O que significa "a consulta foi concluída"?**
Definição operacional exata em §7.2: ferramenta na lista `readTools.search` **e** `tools/result`
com `isError` falso. Nem "o modelo disse que buscou", nem "a chamada foi emitida".

### 10.2 Formulação recomendada (a menos frágil)

> **Invariante de recall.** Em um turno classificado COMPLEX (ou sem classificação), nenhuma
> ferramenta que **muda estado no Basic Memory** é despachada enquanto uma consulta de memória não
> tiver **concluído com sucesso** nesse turno. Leitura é livre. Resultado vazio satisfaz. Falha não
> satisfaz, mas não bloqueia nova tentativa.

Essa formulação é: (i) falsificável mecanicamente, (ii) livre de posição ordinal, (iii) compatível
com paralelismo, (iv) honesta sobre o que não consegue ver.

---

## 11. Ciclo de vida do estado (Questão 7)

### 11.1 Estrutura de estado

```js
// Estado por sessão (Map<sessionId, SessionPolicyState>), em memória apenas.
{
  policyVersion: '1.0.0',        // versão da política (Config.policyVersion)
  pluginVersion: '0.1.0',
  sessionId: '<opaque>',
  turnId: 7,                     // sequência local, incrementada em turn/start
  classification: 'unknown',     // 'unknown' | 'simple' | 'complex'
  classifyCallId: 'call_…',      // qual chamada declarou (auditoria)
  recall: {                      // estado do recall DESTE turno
    state: 'idle',               // idle | in_flight | ok | empty | failed
    attempts: 2,
    lastTool: 'search_notes',
    lastCallId: 'call_…',
    lastOutcomeSeq: 4123,        // seq do tools/result que fechou
    lastAt: 1757...              // epoch ms
  },
  counters: {
    blocked: 1, allowed: 12,
    memoryReads: 3, memoryWrites: 0
  },
  pending: { /* callId -> {tool, at} das chamadas em voo (para casar tools/result) */ },
  writes: { /* path/permalink -> n (por turno) para D2 */ },
  lastBlock: { reasonCode: 'MEMORY_LOOKUP_REQUIRED', at: 1757..., tool: 'write_note' }
}
```

O que **não** entra no estado: conteúdo de notas, argumentos completos, texto do usuário,
transcript, chain-of-thought. Argumentos só são inspecionados de forma efêmera para as checagens
mecânicas (nome de path, `overwrite`, padrões de segredo) e **não** são retidos.

### 11.2 Granularidade: por chamada / turno / tarefa / sessão

| Escopo | O que vive nele | Motivo |
|---|---|---|
| **por chamada** | decisão allow/deny, `reason_code`, contadores | é a unidade que o evento de auditoria descreve; nada persiste além da decisão |
| **por turno** | `classification`, `recall`, `writes`, `lastBlock` | **é o escopo semântico da política**: "esta tarefa exigia recall?" se responde por turno. Reset em `turn/start` |
| **por sessão** | `sessionId`, ponteiros de versão, estado corrente do turno | sobrevive a vários turnos; é onde o `Map` é chaveado; permite estado de turno sem recriar estruturas |
| **por tarefa** | — (não existe no DSH como entidade de primeira classe) | "tarefa" no Harness ≈ "turno do usuário". `turn/start` é o único limite confiável; `agent/session-start` é o limite de sessão |

Não existe escopo "por tarefa" independente. O documento adota **turno = tarefa**, que é o que o
`agent-loop` de fato modela (`turn/start` / `turn/end`) e o que a política textual já assume
("classify every user turn").

### 11.3 Persistência

- **Estado operacional: memória apenas.** É volátil por desenho. Um restart do DSH ou um reload do
  plugin perde o estado e o turno corrente volta a `UNKNOWN` → **fail-closed**. Isso é a escolha
  segura: nunca "herdar" um recall que talvez não tenha acontecido.
- **Eventos de auditoria: duráveis**, via `session.append('bmpp/policy', …)`, porque o log da
  sessão é a fonte de verdade append-only já persistida e já legível pelo verifier existente.
- Nada de arquivo de estado próprio, nada de SQLite, nada de coordenação distribuída entre
  processos.

---

## 12. Comportamento de erro e bloqueio (Questão 8)

### 12.1 Fluxo

```
turno COMPLEX
  → modelo tenta write_note
  → tools/pre-execute: gate avalia recall = RECALL_REQUIRED
  → BMPP devolve { kind: 'deny', reason: <texto acionável> }
  → o registry materializa isError:true com "Error: <reason>" e NÃO despacha o corpo
  → session.append('bmpp/policy', { decision:'deny', reason_code:'MEMORY_LOOKUP_REQUIRED', … })
  → o modelo recebe o erro, chama search_notes
  → tools/result marca RECALL_OK
  → o modelo repete write_note → allow
```

Não há engolimento silencioso: a chamada **ou** roda **ou** devolve erro ao modelo.

### 12.2 Contrato do erro

- **Tipo**: resultado de ferramenta com `isError: true` — o caminho padrão do runtime para `deny`.
  O BMPP **não** lança exceção (isso viraria `toolErrorResult` genérico, menos informativo) e
  **não** usa `ask` no MVP (aprovação humana para uma precondição automática é ruído).
- **Estrutura da mensagem** (texto único, porque `deny.reason` é string):

```
Error: BMPP memory-policy precondition not satisfied: MEMORY_LOOKUP_REQUIRED.
This turn is COMPLEX, so a memory lookup must complete before a Basic Memory operation that
changes state. Do this now: call mcp__basic-memory__search_notes (2-3 phrasings), read the
result, then retry this call. If the turn is genuinely SIMPLE, call bmpp__classify with
{"task":"simple"} first. [bmpp v0.1.0 policy v1.0.0]
```

- **Código machine-readable**: o `reason_code` (`MEMORY_LOOKUP_REQUIRED`, …) é o primeiro token
  identificável do reason; **e** vai estruturado no evento `bmpp/policy`. Para um consumidor
  programático, o evento é a fonte de verdade; a mensagem é para o modelo.
- **Semântica de retry**: a correção é sempre "faça o pré-requisito e **tente de novo em uma chamada
  nova**". O BMPP **não** retenta sozinho (não é um retry-policy, é um gate); ele diz o que falta.
  Repetir a chamada idêntica sem satisfazer o pré-requisito produz o mesmo deny — o bloqueio é
  **idempotente por estado**, não por contagem.
- **Uma leitura (read-only) nunca é negada no MVP**, seja qual for o pré-requisito ausente: é sempre
  possível corrigir o estado sem destravar nada.
- **Chega ao modelo?** **Sim** — é a única forma de o modelo se corrigir.
- **Chega ao usuário?** **Indiretamente**: o resultado de erro aparece na UI como resultado de
  ferramenta (comportamento normal do Harness). O BMPP **não** envia mensagem própria ao usuário,
  **não** usa `ask` e **não** interrompe o turno. Nenhuma informação interna (nomes de arquivo,
  versões, paths) além do necessário.
- **Anti-vazamento**: o reason **nunca** inclui argumentos da chamada, conteúdo de nota, caminhos
  internos do DSH nem stack traces. Os únicos identificadores técnicos são o nome da ferramenta e o
  `reason_code`.

### 12.3 Tabela de códigos

| `reason_code` | Significa | Ação pedida ao modelo | Efeito por `mode` / `profile` |
|---|---|---|---|
| `CLASSIFICATION_REQUIRED` | turno sem `bmpp__classify`; mutação de memória pedida | classificar (complex → buscar; simple → seguir) | closed para mutação |
| `MEMORY_LOOKUP_REQUIRED` | complex, nenhuma busca neste turno | buscar e repetir | closed para mutação |
| `MEMORY_LOOKUP_FAILED` | a busca falhou (`isError`) | repetir a consulta (nova chamada) | closed para mutação |
| `MEMORY_LOOKUP_PENDING_IN_BATCH` | busca e mutação no mesmo lote | repetir a mutação em chamada separada | closed |
| `CREATE_REQUIRES_SEARCH` | `write_note` sem busca prévia no turno | buscar antes de criar | `enforce` → deny; `audit` → warn; `off` → inativo |
| `OVERWRITE_REQUIRES_READ` | `write_note overwrite` sem leitura prévia da nota | `read_note` e então repetir | default `warn`; `profile: strict` → `deny`; `mode: audit` → warn (nunca deny, nunca ask) |
| `DUPLICATE_WRITE_SAME_TURN` | mesma `(tool, path)` repetida no turno | revisar antes de repetir | closed |
| `SECRET_PATTERN_DETECTED` | argumento casa padrão óbvio de segredo (heurística) | remover o segredo do conteúdo | default `warn`; `strict` → `deny`; `audit` → warn |
| `TEST_FIXTURE_LABEL_IN_PROJECT` | `[test-fixture]` em nota fora de diretório de testes | remover o rótulo | default `warn`; `strict` → `deny`; `audit` → warn |
| `POLICY_INTERNAL_ERROR` | exceção inesperada no próprio gate | — (auditado; ver §19) | `open` + auditoria |

Antes da tabela, a regra que resolve `mode` × `profile` de forma não ambígua:

### 12.2.1 Como `mode` e `profile` interagem (normativo)

| Dimensão | Valores | O que controla |
|---|---|---|
| **`mode`** | `off` / `audit` / `enforce` | **se a política está desligada, apenas auditando ou impondo** |
| **`profile`** | `compat` / `strict` | **o nível de rigor** (quais guards são warning e quais são deny; se destrutivas pedem aprovação) |

Regras normativas:

1. `profile` **não** altera `mode`. Nunca. Uma linha com `mode: audit` + `profile: strict` é
   **válida e significativa**: aplica o rigor de `strict` apenas na *decisão auditada* — a decisão
   registrada é `deny`, mas a chamada **é permitida** com `auditOverride: true`.
2. `mode: audit` **nunca** nega e **nunca** pede aprovação. Todo guard de `strict` vira observação.
3. `mode: enforce` é o único que nega e o único que pode `ask` — e `ask` só existe em
   `profile: strict` para as ferramentas destrutivas.
4. `mode: off` desliga tudo: nenhum listener é registrado e nenhuma decisão é tomada. Qualquer
   `profile` é aceito mas **ignorado**, e se a auditoria estiver ligada o evento inicial registra
   `profileIgnored: true` — nunca uma falha de schema por isso.
5. Não existe **nenhuma** segunda forma de configurar a mesma coisa: não há booleano `strict`, não
   há `gateScope`, não há preset que sobrescreva `mode`.

---

## 13. Formato dos audit events (Questões 16 e 17)

### 13.1 Evento durável — formato implementado (incremento 1d)

O rascunho original desta seção previa um payload único com `ts`, `step`, `callId` e `action`. A
implementação real tem **duas formas**, discriminadas por `kind`, porque uma decisão de
`tools/pre-execute` e um desfecho de recall são fatos distintos, com campos distintos. Ambas vão
para o **mesmo** evento de sessão, via module augmentation:

```ts
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'bmpp/policy': BmppPolicyPayload
  }
}

session.append('bmpp/policy', payload)   // em src/audit.ts, único ponto de escrita
```

O `time` e o `seq` do evento **não** entram no payload: o log já os carimba. O rascunho previa
duplicá-los; a implementação não os duplica.

#### 13.1.1 `kind: 'pre-execute'` — uma chamada avaliada

| Campo | Significado |
|---|---|
| `kind` | `'pre-execute'` |
| `harnessTurn?` | turno do Harness, **ausente** quando o host não expõe um — nunca sintetizado |
| `policyTurn` | turnos abertos pelo BMPP, contados **a partir de 1** |
| `tool` | nome público da ferramenta, truncado em 64 caracteres |
| `toolClass` | `memory.read` \| `memory.write` \| `control` \| `other` |
| `policyState` | estado da state machine no momento da decisão |
| `decision` | veredito de **política**, antes de `mode`: `allow` \| `deny` |
| `reasonCode` | código machine-readable (§12.3) |
| `enforcement` | o que o `mode` fez: `allowed` \| `denied` \| `asked` \| `overridden` |
| `enforced` | `true` somente quando `mode: enforce` aplicou o veredito |
| `auditOverride` | `true` quando o modo registrou uma negação sem aplicá-la |
| `classification` | estado que **esta** decisão produziu |
| `recallState` | sub-estado de recall no momento da decisão |
| `observation?` | código de observação, presente só quando houve um |
| `mode` / `profile` | configuração efetiva da linha |
| `policyVersion` | versão da política, vinda da configuração — fonte única |
| `pluginVersion` | versão do BMPP que escreveu o evento |

#### 13.1.2 `kind: 'recall'` — uma consulta obrigatória liquidada

| Campo | Significado |
|---|---|
| `kind` | `'recall'` |
| `harnessTurn?` / `policyTurn` | idem acima |
| `tool` | a ferramenta de busca cujo resultado liquidou o recall |
| `toolClass` | sempre `memory.read` |
| `recallState` | sub-estado **depois** de aplicar o desfecho |
| `recallOutcome` | `ok` \| `failed` — na prática `empty` é inalcançável (§7.4a) |
| `classification`, `mode`, `profile`, `policyVersion`, `pluginVersion` | idem acima |

#### 13.1.3 Os dois turnos **não** são a mesma coisa

`policyTurn` conta os turnos que **o BMPP abriu** — 1 no primeiro turno observado, 2 no seguinte —
e `harnessTurn` é o número de turno do **Harness**, presente apenas quando o host o reporta
(`turnBoundary.lastTurn`). Eles coincidem por acidente em muitos casos e **não** são
intercambiáveis: um host sem projeção de turno produz eventos com `harnessTurn` ausente e
`policyTurn` perfeitamente utilizável. Um teste dedicado afirma que os dois divergem quando
divergem, e que `harnessTurn` **nunca** é derivado de `policyTurn`.

#### 13.1.4 Falha de auditoria não altera veredito

`appendAudit()` captura tudo: ausência de `append`, exceção do `append`, sessão já descartada. O
gate conta a falha (`auditFailureCount`), emite **um** warning por sessão e segue — a política não
fica menos confiável porque o log quebrou. Coberto por três testes de integração que afirmam que o
veredito e a execução da ferramenta permanecem idênticos com o append quebrado.

#### 13.1.5 Privacidade do payload (ver §14)

- **nunca** conteúdo de nota, argumentos da ferramenta, texto do usuário, transcript ou
  chain-of-thought — o payload só carrega nomes, classes, estados, códigos e contadores;
- o payload é JSON lossless **por construção**; uma chave com valor `undefined` é rejeitada pelo log
  (`session.append` valida), então campos ausentes são **omitidos**, não nulos — descoberto na
  implementação e garantido agora pelo compilador (`exactOptionalPropertyTypes`).

### 13.2 Perguntas que a auditoria responde mecanicamente

| Pergunta | Como | Ferramenta |
|---|---|---|
| "Esta tarefa exigia consulta à memória?" | existe `bmpp/policy` com `classification:'complex'` (ou `'unknown'`) para o turno | `grep`/jq no log da sessão |
| "A consulta obrigatória foi realizada?" | evento com `kind:'recall'` e `recallOutcome:'ok'` | idem |
| "Por que esta chamada foi permitida?" | evento com `decision:'allow'` + `reasonCode`, ou `enforcement:'overridden'` quando o modo a deixou passar | idem |
| "Por que esta chamada foi bloqueada?" | evento com `decision:'deny'`, `reasonCode` e `enforcement` | idem |
| "O estado foi resetado?" | `policyTurn`/`harnessTurn` avançam entre eventos do mesmo `sessionId` | idem |
| "Reproduzível nos testes?" | os mesmos eventos são afirmados pela suíte vitest | §18 |

Isso torna `policy_verify.py` **obsoleto para as regras que o BMPP impõe** (ele passa a ler eventos
estruturados em vez de inferir ordem de `tool/call`) — mas ele é **preservado** para as regras que
continuam soft (§18.20).

### 13.3 Modelo de configuração (normalizado)

Duas dimensões ortogonais e explícitas. **Não existe booleano `strict`**, não existe segunda forma
de configurar a mesma coisa, e `profile` **nunca** altera `mode`.

```js
export const Config = z.object({
  // --- as duas dimensões de controle ---
  mode: z.enum(['off', 'audit', 'enforce']).default('audit'),
  profile: z.enum(['compat', 'strict']).default('compat'),

  // --- política de recall (o núcleo) ---
  onMissingClassification: z.literal('treat_complex').default('treat_complex'),
  searchTools: z.array(z.string()).default(['mcp__basic-memory__search_notes',
    'mcp__basic-memory__search', 'mcp__basic-memory__build_context']),
  readTools: z.array(z.string()).default([/* as 15 leitoras da §8 */]),
  mutatingTools: z.array(z.string()).default([/* as 6 mutadoras da §8 */]),
  unknownMemoryToolPolicy: z.enum(['deny', 'warn', 'allow']).default('deny'),

  // --- gates secundários (default warn em todos) ---
  createRequiresSearch: z.boolean().default(true),
  overwriteRequiresRead: z.enum(['off', 'warn', 'deny']).default('warn'),
  duplicateWriteGuard: z.boolean().default(true),
  secretPatternGuard: z.enum(['off', 'warn', 'deny']).default('warn'),
  testFixtureGuard: z.enum(['off', 'warn', 'deny']).default('warn'),
  testFixtureAllowedPrefixes: z.array(z.string())
    .default(['tests/', 'archive/policy-tests/']),

  // --- destrutivas ---
  destructiveTools: z.array(z.string()).default(['mcp__basic-memory__delete_note',
    'mcp__basic-memory__delete_project']),

  // --- auditoria e operação ---
  auditLevel: z.enum(['off', 'decision', 'verbose']).default('decision'),
  pathRedaction: z.enum(['truncate', 'hash', 'full', 'omit']).default('truncate'),
  maxPathChars: z.number().int().positive().default(64),
  policyVersion: z.string().default('1.0.0'),
  testMode: z.boolean().default(false),
})
```

**Não existe `gateScope`.** O escopo é fixo no Basic Memory (§6.4) e ampliá-lo exige decisão nova,
não um campo.

#### 13.3.1 O que cada `profile` altera (definição exata)

| Opção | `compat` | `strict` | Observação |
|---|---|---|---|
| `onMissingClassification` | `treat_complex` | `treat_complex` | **igual nos dois** — o default conservador nunca é afrouxado |
| `unknownMemoryToolPolicy` | `deny` | `deny` | **igual nos dois** — `strict` não acrescenta rigor |
| `createRequiresSearch` | `true` | `true` | **igual nos dois** — `strict` não acrescenta rigor |
| `duplicateWriteGuard` | `true` | `true` | **igual nos dois** — booleano sem nível intermediário; `strict` não acrescenta rigor |
| `overwriteRequiresRead` | `warn` | **`deny`** | regra alterada por `strict` |
| `secretPatternGuard` | `warn` | **`deny`** | regra alterada por `strict` |
| `testFixtureGuard` | `warn` | **`deny`** | regra alterada por `strict` |
| `destructiveTools` | gate normal, **sem `ask`** | gate normal **+ `ask`** (aprovação) | |
| `searchTools` / `readTools` / `mutatingTools` | inalterados | inalterados | listas de classificação, não de rigor |
| `pathRedaction` / `auditLevel` / `maxPathChars` | inalterados | inalterados | auditoria não é rigor de política |

**Documentação da redundância (exigência explícita):** em `profile: strict`, as opções
`onMissingClassification`, `unknownMemoryToolPolicy`, `createRequiresSearch` e
`duplicateWriteGuard` **não mudam** em relação a `compat`. Ou seja, nessas quatro o perfil `strict`
**não acrescenta rigor útil** — elas já estão no máximo conservador desde o default. Isso é
deliberado, para que não exista dois níveis de "conservador" e ninguém suponha que `strict` guarda
algo a mais ali.

#### 13.3.2 Validação e defaults

Validado no schema (zod + `superRefine`) na montagem da linha:

- `mode` e `profile` só aceitam os valores do enum — valor desconhecido **rejeita a linha**;
- `mode: off` aceita qualquer `profile` mas o ignora (não é erro);
- **combinação ambígua é rejeitada** pela regra "uma dimensão só faz uma coisa": nenhuma opção do
  schema pode implicar `mode`.

**Defaults aprovados: `mode: 'audit'` + `profile: 'compat'`.** Vale repetir o efeito dessa
combinação, porque é contraintuitiva à primeira vista:

> Com `mode: audit`, o BMPP **decide tudo** (inclusive os `deny` de recall) e **registra a decisão**,
> mas **não bloqueia nada**. Ele é um observador de política com decisão completa. O rollout torna-se
> `enforce` por mudança explícita de uma linha — e depois a avaliação de `strict`.

Sequência de rollout:

| Etapa | Configuração | Efeito |
|---|---|---|
| 1 (default) | `mode: audit` + `profile: compat` | observa, audita, não bloqueia |
| 2 | `mode: enforce` + `profile: compat` | impõe o núcleo; secundários em `warn` |
| 3 | `mode: enforce` + `profile: strict` | secundários em `deny` e destrutivas com `ask` |
| — | `mode: off` | desliga sem remover a linha |

---

## 14. Projeto de segurança e privacidade (Questão 16)

Princípios:

1. **Metadados, não conteúdo.** O estado e os eventos carregam apenas nomes de ferramenta, classes,
   decisões, códigos e timestamps. Conteúdo de nota e argumentos **nunca** são retidos nem
   auditados.
2. **Nunca chain-of-thought.** O `rationale` de `bmpp__classify` é uma linha de rótulo, não
   raciocínio; o BMPP não pede, não armazena nem registra raciocínio.
3. **Segredos.** O guard de segredos inspeciona o argumento **em memória** e descarta o valor. O
   evento registra apenas `SECRET_PATTERN_DETECTED` + a **classe** do padrão (`bearer`,
   `api_key_prefix`, `private_key_block`), nunca o valor nem um trecho dele.
   **`secretPatternGuard` é heurístico** e deve ser descrito assim em toda a documentação e na
   mensagem ao modelo: ele pega padrões óbvios (prefixos de chave, `Bearer`, bloco de chave
   privada) e **não** é proteção completa contra secrets. Um segredo sem forma reconhecível passa.
   Por isso o default é `warn`, e por isso `strict` sobe para `deny` apenas como reforço, não como
   garantia.
4. **Paths/permalinks.** Podem revelar estrutura e nomes de projetos. Default: truncar em 64
   caracteres. Alternativas: `hash` (SHA-256 curto, estável para correlação sem revelar) ou `omit`.
   Recomendação: `truncate` para este ambiente single-user local; `hash` se a auditoria for
   compartilhada.
5. **Nada de rede.** O BMPP não tem I/O de rede. Sem telemetria, sem cloud.
6. **Nada de escrita em disco própria.** Sem arquivo de estado, sem log próprio (o log durável é o
   da sessão, gerenciado pelo Harness).
7. **Não persistir transcripts.** Explícito.
8. **Sandbox.** O plugin roda no host (dentro do processo DSH), então **não** está sujeito ao
   sandbox de `bash`. Ele não executa processos nem toca o filesystem — só observa metadados do
   pipeline. Isso mantém a superfície de risco próxima de zero.
9. **Fail-closed vs fail-open por categoria** (§19), nunca uniforme.

---

## 15. Estratégia de testes (Questão 18)

### 15.1 Camadas

| Camada | O que prova | Como |
|---|---|---|
| **L1 unitário do gate** | a state machine decide certo para um estado dado | chamar o avaliador puro `decide(state, call)` sem DSH |
| **L2 integração no pipeline** | o gate realmente nega/permite através de `ToolRuntime` | `Context` + `ToolRuntime` + tools fixture, `tools/pre-execute` real |
| **L3 end-to-end no agent-loop** | o modelo recebe o erro e consegue se recuperar | padrão de `packages/core/agent-loop/tests/interception.spec.ts` com `MockAdapter` roteirizado |
| **L4 contra o Basic Memory real** | integração MCP real (nomes, erros, vazio) | sessão viva com as 21 ferramentas |
| **L5 regressão da suíte existente** | a política textual continua válida | `policy_verify.py` com os 12 cenários |

### 15.2 Os 20 cenários obrigatórios mapeados

| # | Cenário (pedido) | Camada | Regra afirmada |
|---|---|---|---|
| 1 | tarefa SIMPLE | L1+L3 | `classify{simple}` → nenhum gate; mutação permitida |
| 2 | COMPLEX com consulta correta | L3 | `classify{complex}` → `search_notes` → allow da mutação; eventos `allow` com `reasonCode=ALLOW_RECALL_OK` |
| 3 | COMPLEX sem consulta | L3 | mutação negada, `MEMORY_LOOKUP_REQUIRED`, resultado `isError` visível ao modelo |
| 4 | COMPLEX em que `search_notes` falha | L2+L3 | `isError` da busca → `RECALL_FAILED` → mutação negada `MEMORY_LOOKUP_FAILED`; nova busca OK → allow |
| 5 | COMPLEX com zero resultados | L2+L3 | `results: []`, sem erro → `RECALL_EMPTY` → **allow** |
| 6 | `search_notes` repetido | L1 | segundo recall não regride estado; permitido; contador de tentativas |
| 7 | repetir ferramenta depois do bloqueio | L1 | bloqueio idempotente; sem satisfazer pré-requisito, segundo deny idêntico |
| 8 | reset entre tarefas | L1 | `turn/start` zera `classification` e `recall`; gate reabre fechado |
| 9 | reset entre sessões | L1 | `agent/session-start` cria estado novo; nenhum recall herdado |
| 10 | execução paralela | L2 | lote `search_notes` + `write_note` → mutação negada `MEMORY_LOOKUP_PENDING_IN_BATCH`; lote de duas leituras → ambas permitidas |
| 11 | fixture com `[test-fixture]` | L1 | escrita dentro de `testFixtureAllowedPrefixes` → sem aviso |
| 12 | nota real sem `[test-fixture]` | L1 | `[test-fixture]` fora dos prefixos → `TEST_FIXTURE_LABEL_IN_PROJECT` (warn/deny conforme `profile`) |
| 13 | overwrite + leitura possivelmente stale | L2+L4 | plugin **não** reage à leitura; **não** emite escrita duplicada; verificação usa o retorno da própria escrita |
| 14 | `move_note` | L2+L4 | `move_note` é mutação: exige recall; é allow após recall; auditoria registra; plugin **não** assume mudança de identidade lógica (§16) |
| 15 | fluxo archived/superseded | L4 | `move_note` para `archive/` permitido após recall; a nota antiga mantém permalink; plugin não cria nota nova |
| 16 | tentativa de registrar segredo | L1 | padrão óbvio em argumento → `SECRET_PATTERN_DETECTED`; evento **não** contém o valor |
| 17 | restart/reload do plugin | L2 | novo `apply` → estado vazio → turno `UNKNOWN` → mutação negada (fail-closed); disposer remove listeners sem vazar |
| 18 | mudança de versão da política | L1+L2 | `policyVersion` diferente aparece nos eventos; estado antigo é descartado no reload |
| 19 | chamadas malformadas/inesperadas | L1 | `exec.name` desconhecido no namespace → fail-closed (`UNKNOWN_MEMORY_TOOL`); `arguments` não-objeto → não lança, trata como desconhecido e audita |
| 20 | regressão dos 12 cenários/20 regras | L5 | `policy_verify.py policy_spec.json` continua **0 falhas**; as regras agora cobertas pelo BMPP ganham asserção dupla (evento + verifier) |
| **21** | **`mode: audit` não bloqueia** | L2 | com `mode: audit`, todo cenário de deny (3, 4, 10) passa a **allow** com `auditOverride: true` no evento — é o default aprovado, então este teste é o que garante que o default é inofensivo |
| **22** | **`profile` não altera `mode`** | L1 | `audit+strict` → permite e registra deny; `enforce+strict` → nega; `enforce+compat` → secundários em `warn`; nenhuma combinação muda `mode` por conta própria |
| **23** | **schema rejeita valores inválidos e combinações ambíguas** | L1 | `mode: 'yes'`, `profile: 'hard'`, `gateScope: ...` (chave inexistente estrita) → a linha **não monta**; `off`+`strict` monta e ignora o perfil |
| **24** | **`ask` só em `enforce` + `strict`** | L2 | `delete_note` em `audit+strict` → **nunca** chama o approval; em `enforce+strict` → `ask`; em `enforce+compat` → gate normal, sem `ask` |

### 15.3 Regras de qualidade dos testes

- **Não enfraquecer o verifier existente.** `policy_verify.py` permanece e roda como regressão; se o
  BMPP mudar o comportamento observável, a mudança é justificada e o verifier é **estendido**, não
  afrouxado.
- **Nada de auto-relato.** Toda asserção vem do log da sessão ou do retorno do pipeline — mesma
  filosofia do método anterior ("a verificação é mecânica, nada é auto-relatado").
- **Fixtures determinísticas.** Mock adapter roteirizado em L3; sem waits de relógio; o estado é
  injetável.
- **Teste negativo obrigatório**: para cada gate, um caso que **deve** ser negado.
- **Cobertura**: o repositório usa gate de 100% por arquivo em `packages/**`. Se o BMPP nascer como
  pacote dentro do checkout, ele herda esse gate; se nascer fora, a suíte é própria com meta
  equivalente (100% de branch nos caminhos de decisão).

---

## 16. Identidade de notas, versionamento e arquivamento (Questão 10)

Adotado como decisão explícita de projeto (o BMPP **assume** estes fatos, não tenta contorná-los):

**A. `move_note` move.** `move_note` muda a localização da nota, e com
`update_permalinks_on_move: false` (estado observado) o permalink de origem é preservado. O BMPP
**nunca** trata `move_note` como garantia de mudança de identidade lógica — ele o classifica como
mutação de localização, ponto. A política não pode depender dele para representar substituição.

**B. Referências estáveis mudam por criação + arquivamento, não por move.**
Para um conceito que muda materialmente, a prática canônica é:

```
criar uma nova nota canônica
  + marcar a anterior como arquivada/superseded (move_note para archive/ + relação supersedes)
```

O BMPP **não impõe** isso (é decisão semântica), mas **observa e audita** para tornar a prática
verificável: se uma nota é editada de forma que troca o significado (não detectável mecanicamente),
nada acontece; se uma nota é criada com título muito parecido com uma existente (detectável
mecanicamente), o BMPP emite `POSSIBLE_DUPLICATE_TITLE` (nível 2, §17).

**C. Rastreabilidade histórica preservada.** O BMPP nunca sugere `delete_note` para substituição;
`delete_note` é classificado como destrutivo e, em `strict`, vira `ask`. Arquivar é o caminho.

**D. Os cinco tipos de mudança são distinguidos conceitualmente** (e o BMPP só distingue
mecanicamente os que consegue):

| Mudança | Detectável mecanicamente? | Ação do BMPP |
|---|---|---|
| mudança de **localização** | sim (`move_note`) | classe mutação; exige recall; audita |
| mudança de **título** | parcial (título no argumento de `write_note`) | audita; compara com títulos existentes quando disponível |
| **substituição semântica** | **não** | decisão do modelo (Gate 3); nada |
| **arquivamento** | sim (`move_note` com destino `archive/`) | classe mutação; audita; verifica se o destino está na convenção `archive/` |
| **supersession** | parcial (relação no conteúdo, ou o par criar+arquivar) | audita o par quando ambos ocorrem no mesmo turno |

**E. Cache/consistência (read-after-write).** Documentado em §4.2. Regra de ouro para o BMPP e para
os testes:

> **Nunca** criar nota duplicada nem repetir `write` para contornar leitura desatualizada. A
> verificação de que uma escrita ocorreu usa o **retorno da própria operação**, não um `read_note`
> posterior.

---

## 17. Prevenção de duplicatas (Questão 13)

Três níveis, com veredito explícito sobre o que é garantível:

| Nível | O que é | Garantível? | Como | Ação |
|---|---|---|---|---|
| **1. Writes repetidos por sequência inválida** | mesma `(tool, path)` no mesmo turno; escrita antes do recall | **SIM** | estado do turno | `DUPLICATE_WRITE_SAME_TURN` / `MEMORY_LOOKUP_REQUIRED` |
| **2. Colisão exata de identidade/path** | `write_note` com `overwrite:false` que criaria permalink duplicado (`-1`/`-2`), ou título exatamente igual a uma nota existente | **SIM, com ressalva**: o BMPP vê o **retorno** da operação (`permalink` com sufixo `-1`/`-2`) e o título do argumento | observação do `tools/result` + comparação com títulos retornados por busca anterior no turno | **detecta e reporta** (`POSSIBLE_DUPLICATE_PERMALINK`, `POSSIBLE_DUPLICATE_TITLE`); **não** apaga nem corrige sozinho |
| **3. Duplicação semântica** | duas notas que dizem a mesma coisa com palavras diferentes | **NÃO** | — | permanece com o modelo; o BMPP no máximo inclui essa observação no contexto (opt-in), jamais age |

Ressalva honesta do nível 2: o `tools/result` de `write_note` traz o permalink/`file_path`, então
"o que foi criado" é observável; mas o BMPP **não** tem uma consulta estruturada de "todos os
títulos existentes" barata e determinística a cada escrita, e chamar `search_notes` sozinho para
isso seria (i) uma chamada extra de MCP dentro do plugin, (ii) lenta, (iii) uma decisão semântica
terceirizada. Portanto o nível 2 é implementado **apenas** como observação do que já veio de graça
(retorno da operação + buscas que o modelo já fez no turno), e **nunca** como bloqueio preventivo
por similaridade.

Nível 3 explicitamente **não implementado**. O documento se recusa a prometer isso.

Complemento mecânico barato (opcional, `Config.duplicateWriteGuard`): repetição da mesma escrita no
mesmo turno é bloqueada. Isso mata a classe de duplicata nascida de retry/loop, que é a única
causada por falha mecânica.

---

## 18. "Memória é contexto, não autoridade" (Questão 14)

O princípio é conceitual e permanece onde deve estar: no texto. O BMPP contribui apenas garantindo
a assimetria certa — **nunca** trata a memória como fonte de verdade.

| Onde o princípio aparece | Como |
|---|---|
| **`~/.dsh/AGENTS.md`** | permanece o **Gate 2** explícito ("Recalled notes are leads, not facts"; "Live evidence wins over memory"). Adicionar uma linha curta apontando que o BMPP impõe a *precondição* de recall, não a *validade* do conteúdo — para o modelo não confundir gate mecânico com verificação semântica. É a única mudança textual proposta (§20) |
| **Comportamento do plugin** | o BMPP não lê conteúdo de nota, não avalia qualidade, não ordena/rankeia resultados, não resume, não corrige nota desatualizada e não impede o modelo de contradizer a memória. Ele só verifica **que a consulta aconteceu**. Um recall "ok" nunca é apresentado como "conteúdo confiável" |
| **Eventos de auditoria** | `bmpp/policy` só afirma `recall: {state:'ok'}` — nunca `content_valid`. O vocabulário do evento não tem campo que sugira autoridade. Documentado no schema do evento |
| **Testes** | o cenário 13 (§15.2) e o cenário "memória desatualizada" afirmam o contrário do reflexo errado: o agente **deve** seguir a evidência viva, e o BMPP **não** intervém nessa escolha. Um teste dedicado afirma: BMPP permite mutação mesmo quando a nota consultada contradiz o sistema vivo |

Frase operacional que o design preserva: **o BMPP verifica que a memória foi consultada; o modelo
verifica que a memória está certa.**

---

## 19. Modos de falha (Questão 22)

Decisão por categoria — nunca uniforme.

| Cenário | Categoria | Decisão | Justificativa |
|---|---|---|---|
| Basic Memory indisponível (MCP child morto) | infraestrutura | **fail-open com auditoria** para leitura; **fail-closed** para mutação de memória | bloquear leitura quando o servidor cai trava o Harness sem ganho; mas "mutar sem poder buscar" é exatamente o que a política quer evitar |
| Timeout do MCP | infraestrutura | igual acima: `isError` no `tools/result` → `RECALL_FAILED` → mutação negada; leitura permitida | o timeout é indistinguível de falha e a resposta é a mesma |
| Erro de `search_notes` | política | **fail-closed para mutação**, com retry permitido | já coberto (§10.2) |
| Resposta MCP malformada | integridade | **warn + allow** e auditoria `MALFORMED_RESULT` | o BMPP não valida conteúdo; recusar-se a operar por um resultado estranho bloquearia trabalho legítimo |
| Corrupção do estado do plugin | integridade | **reset do estado do turno + fail-closed para mutação + auditoria `POLICY_STATE_RESET`** | um estado inconsistente não pode autorizar escrita; reset é seguro porque o pior caso é pedir a busca de novo |
| Restart do DSH | ciclo de vida | estado perdido → turno `UNKNOWN` → **fail-closed** para mutação | nunca herdar recall que talvez não tenha ocorrido |
| Interrupção da sessão (`turn/end` sem resultado) | ciclo de vida | descarta estado do turno; próximo `turn/start` reseta | idempotente |
| Reload do plugin (`patchReload: live`) | ciclo de vida | disposers removem listeners; estado novo e vazio → fail-closed | testado no cenário 17 |
| Tarefas concorrentes (dois agentes/steering) | concorrência | estado **por sessão**; `tools/pre-execute` é ordenado por lote; sem lock global | o escopo por sessão elimina a corrida; não há estado compartilhado mutável entre sessões |
| Eventos duplicados (`tools/result` repetido) | idempotência | transições de recall são idempotentes; contadores idempotentes por `callId` | repetir "ok" mantém `ok` |
| Cache stale (read-after-write) | integridade | **allow** e nenhuma ação; documentado | §4.2/§16-E: não é problema do BMPP e a "correção" (escrever de novo) é proibida |
| Metadados ausentes (`exec.agent` indefinido) | integridade | **no-op (allow)** + auditoria `NO_AGENT_CONTEXT` | sem agente não há turno; bloquear seria bloquear fora de contexto |
| Ferramenta desconhecida **no namespace de memória** | política | **fail-closed** (`UNKNOWN_MEMORY_TOOL`) | princípio: novidade não abre buraco |
| Ferramenta desconhecida **fora** do namespace | escopo | **allow** + auditoria (nível `verbose`) | fora do escopo do BMPP |
| Atualização da versão do plugin | ciclo de vida | estado descartado no reload; `pluginVersion`/`policyVersion` novos em todo evento | permite correlação histórica |
| **Exceção no próprio gate** | defeito | **fail-open + auditoria obrigatória `POLICY_INTERNAL_ERROR`** | um bug no plugin não pode parar o Harness; a auditoria torna o defeito visível e o teste dedicado o pega |
| Config inválida (schema) | configuração | **o plugin não monta** (zod rejeita a linha) | falha alta e visível, não silenciosa |
| `mode: off` com `profile: strict` | configuração | **allow incondicional** + evento `profileIgnored: true` | `off` significa desligado; o perfil não pode ressuscitar política |
| `mode: audit` com `profile: strict` | configuração | **allow sempre**, mas o evento registra a decisão `deny` que teria sido aplicada (`auditOverride: true`) | auditar o rigor sem quebrar nada |
| `profile: strict` + operação destrutiva, sem serviço de approval | aprovação | **fail-closed** (`deny` = o `ask` normaliza para deny quando não há answerer) | comportamento já garantido pelo seam de approval do DSH (`ctx.get('approval')` ausente → deny) |

Padrão geral: **falha de infraestrutura → open para leitura, closed para mutação de memória;
falha do próprio plugin → open com auditoria; estado ausente/corrompido → closed com reset.**
Transversal: **`mode: audit` e `mode: off` nunca bloqueiam e nunca pedem aprovação**, qualquer que
seja a linha da tabela acima; `ask` só existe em `mode: enforce` + `profile: strict`.

---

## 20. Compatibilidade e migração (Questão 19)

### 20.1 O que **não** muda

- `~/.dsh/AGENTS.md` — a política textual permanece; ganha **no máximo** uma linha conectando-a ao
  BMPP.
- Nota `Instructions/DSH Memory Policy` — permanece; recebe uma seção "enforcement" apontando o
  BMPP e os `reason_code`.
- Integração MCP (`mcp-basic-memory`), estrutura de notas, layout de pastas, config de embeddings,
  `semantic_min_similarity: 0.4`, skills `memory-*`, workflows do DSH: **intocados**.
- Nomes/ordem dos gates: inalterados.

### 20.2 O que muda (e como verificar)

| # | Comportamento | Muda para | Por quê | Verificação |
|---|---|---|---|---|
| M1 | "primeiro tool call DEVE ser `search_notes`" | "nenhuma **mutação de memória** antes do recall; leitura é livre; `bmpp__classify` pode vir antes" | corrige a fragilidade §10 | cenários 1,2,3,10 passam; T1b continua passando (a busca ainda é a primeira chamada *de memória*) |
| M2 | classificação só no texto | declaração explícita via `bmpp__classify` | torna D6 auditável | eventos com `classification`; cenário 8 |
| M3 | escrita antes da busca era possível | negada com erro acionável | é o objetivo do projeto | cenário 3 |
| M4 | `policy_verify.py` infere ordem de `tool/call` | passa a poder ler eventos `bmpp/policy`; **continua rodando** como regressão | auditoria estruturada | cenário 20: 12 cenários, 0 falhas |
| M5 | `[test-fixture]` podia aparecer em nota real | aviso (`compat`) ou negação (`strict`) conforme `testFixtureGuard` | fecha D2 | cenários 11,12 |
| M6 | qualquer política ligada por default | **default `mode: audit` + `profile: compat`**: observa e audita, não bloqueia | rollout seguro: o primeiro efeito é evidência, não bloqueio | cenário 21 |

### 20.3 Passos de migração (quando aprovado)

0. **Preparar o versionamento Git (§25), com autorização explícita.** Nada é criado antes disso.
1. Criar o projeto standalone `<workspace>/bmpp/` e a suíte (fases 1–2 do §27).
2. Montar com o **default aprovado `mode: audit` + `profile: compat`** e deixar rodar turnos reais;
   verificar que os eventos registram decisões `deny` sem que **nada** bloqueie.
3. Comparar com a suíte existente: rodar `policy_verify.py` (deve continuar 0 falhas).
4. Ligar `mode: 'enforce'` mantendo `profile: 'compat'` (guards secundários ainda em `warn`).
5. Rodar a suíte completa (24 cenários) + os 12 de regressão.
6. Ajustar `AGENTS.md` (uma linha) e a nota de política (seção enforcement).
7. Só então avaliar `profile: 'strict'` — e reverter para `compat` é uma linha.

Rollback em qualquer passo: `mode: 'off'` ou remover a linha do patch (o perfil é `patchReload:
live`, então o efeito é imediato e sem restart).

---

## 21. Limitações conhecidas

1. **O plugin não entende semântica.** Não sabe se a tarefa *realmente* era complexa, se a memória
   consultada era relevante, ou se a nota escrita era duplicata semântica. Isso é projeto, não bug.
2. **Depende de cooperação para a classificação.** Sem `bmpp__classify`, o turno é tratado como
   COMPLEX (conservador). O plugin não adivinha.
3. **`deny.reason` é texto plano.** Não há campo estruturado no `PreToolDecision`; o código
   machine-readable vive no evento de auditoria, não no resultado da ferramenta. Um consumidor
   programático deve ler o log.
4. **Sem reescrita de argumentos.** O BMPP não pode corrigir uma chamada; só negar e instruir.
5. **Sem contexto pré-injetado no MVP.** A opção de injetar o resultado da busca via
   `agent.inject` existe no Harness, mas muda o fluxo do modelo e foi deixada fora (§24, Q4).
6. **Escopo limitado a ferramentas do Basic Memory** (fixo no MVP, não configurável). Ferramentas
   mutadoras fora do Basic Memory não são gateadas, auditadas nem classificadas — e não há opção de
   configuração que amplie isso (§6.4).
7. **Estado volátil.** Um reload perde o recall do turno → fail-closed (comportamento desejado, mas
   significa uma negação a mais após reload).
8. **O guard de segredos é heurístico.** Pega padrões óbvios e erra nos sutis; por isso começa em
   `warn`.
9. **O read cache/staleness não é resolvido.** Apenas documentado (§4.2).
10. **Um teste que dependa de paralelismo real de dois corpos é impossível de garantir** — o que se
    testa é a decisão do gate no `pre-execute` ordenado, que é o comportamento real do runtime.

---

## 22. Riscos e trade-offs

| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Falso bloqueio trava trabalho legítimo | média | alto | leitura sempre livre; guards secundários em `warn` por default; `mode: 'audit'` para rollout; reason acionável |
| O modelo não chama `bmpp__classify` | média | médio | default conservador (trata como COMPLEX) — nunca libera por omissão; a mensagem de erro ensina a chamada |
| Custo de tokens: +1 ferramenta no prompt | certa | baixo | schema minúsculo (2 campos); uma ferramenta a mais entre ~25 |
| Lista de ferramentas de memória fica obsoleta (upgrade do Basic Memory) | média | médio | `unknownMemoryToolPolicy: 'deny'` + teste de contrato que compara as listas com `tools/list` real (falha o teste quando o servidor publicar algo novo) |
| Complexidade acidental no plugin | média | médio | state machine de 5 estados, sem I/O, sem LLM, sem persistência própria; orçamento explícito de ~400–600 linhas de JS |
| Colapso da distinção hard/soft na prática | baixa | alto | §9 é normativo; qualquer nova regra precisa de um "sinal concreto do runtime" na tabela ou não entra |
| Duplicação de mecanismo com o `AGENTS.md` | média | baixo | o texto **explica**, o plugin **impõe** — papéis declarados em §5 e §18; a nota de política ganha uma seção que aponta o plugin |
| Divergência entre versões (política textual v evolui, plugin não) | média | médio | `policyVersion` em todo evento; a suíte de regressão roda contra o texto atual |
| Exceção no gate derruba o turno | baixa | alto | todo o gate é envolvido em try/catch com fail-open + `POLICY_INTERNAL_ERROR` auditado |
| Pacote local não resolve no perfil | média | alto | §23 documenta a resolução; a Fase 1 monta e confirma na prática, com `mode: 'off'` como primeiro teste |

---

## 23. Onde o pacote vive e como é carregado (Questão 20)

Fatos verificados:

- O perfil monta o `cordis.yml` do perfil com `ctx.baseUrl = <dir do cordis.yml>`
  (`$DSH_HOME/profiles/web/`).
- `tree.import(name)` (`vendor/loader/src/config/tree.ts:145`): `cordis:*` → builtin; `./…` ou
  `../…` → `new URL(name, ctx.baseUrl)`; qualquer outro → `import(name)` (bare specifier resolvido
  a partir do loader do DSH).

**Local decidido (rev. 3): projeto standalone em `<workspace>/bmpp/`**, com **repositório Git
próprio**, ciclo de vida próprio e versionamento independente do DSH.

O que isso significa concretamente:

- o BMPP **não** é um pacote do monorepo do DSH e **não** fica em `deepseek-harness/packages/`;
- **não** existe `git init` dentro do checkout do DSH nem repositório Git aninhado;
- o checkout do DSH permanece o **clone oficial**: remote oficial intacto, sem fork, sem branch
  nova, sem alteração local;
- o DSH passa a ser uma **dependência** do BMPP, não seu hospedeiro;
- a documentação de arquitetura vive dentro do repositório do BMPP e evolui com o código.

Aplicação da decisão a este ambiente:

| Item | Valor |
|---|---|
| Caminho do projeto | `<workspace>/bmpp/` |
| Repositório Git | próprio, independente (`<workspace>/bmpp/.git`), branch inicial `main` |
| Checkout do DSH | `<dsh-checkout>/` — clone oficial, **não modificado**, não é fork |
| Papel do DSH | dependência de API e de envelope de versão |
| Distribuição | bundle do DSH (`dsh.bundle.patch` → `cordis.patch.yml`) |
| Desenvolvimento | overlay `--patch` com caminho absoluto (§ `docs/DISTRIBUTION.md`) |
| Versionamento | próprio (SemVer), com envelope de compatibilidade `dsh.compatibility` |
| Documentação | `docs/ARCHITECTURE.md`, `docs/COMPATIBILITY.md`, `docs/DISTRIBUTION.md` no próprio repo |

Configuração prevista da linha (fase 4, **não** agora):

```yaml
- insert:
    - id: bmpp
      name: 'dsh-bmpp'
      config:
        mode: audit        # default aprovado
        profile: compat    # default aprovado
        policyVersion: '1.0.0'
```

Nenhum `cordis:` novo, nenhum serviço publicado — logo o BMPP é uma linha de **host composition**
(não um agent preset): ele observa o `ToolRuntime` global e deve valer para toda sessão.

> Verificação pendente para a Fase 1: confirmar **empiricamente** que um bare specifier de pacote
> do monorepo resolve a partir do diretório do perfil (`tree.import` → `import(name)`). Está
> fundamentado no comportamento observado (`@deepseek-ai/dsh-mcp-client` resolve hoje), mas só será
> dado como certo depois de montar e ver o plugin carregar.

---

## 24. Questões em aberto que exigem decisão do usuário

### Decididas na rev. 2 (não são mais questões abertas)

| # | Decisão |
|---|---|
| Q1 | **Rev. 3:** o BMPP vive em `<workspace>/bmpp/` como **projeto standalone com Git próprio**; o checkout do DSH permanece clone oficial, sem fork e sem alteração |
| Q2 | Escopo do MVP: **somente ferramentas do Basic Memory**; `bash`, `edit`, `write`, `terminal` e demais não são governadas |
| Q3 | `bmpp__classify` **não** precisa ser a primeira tool call; classificação obrigatória apenas para liberar SIMPLE |
| Q4 | `search` + `write` no mesmo lote → write negado (`MEMORY_LOOKUP_PENDING_IN_BATCH`); **gate não vai para `tools/execute`** nesta fase |
| Q5 | Stale read **não** será investigado agora: limitação documentada, **sem workaround**, **sem repetir writes**, **sem read-after-write como prova** |
| Q6 | `ask` para destrutivas **somente** em `enforce` + `strict` |
| Q7 | Guards secundários em `warn` por default; `strict` → `deny`; guard de segredo é heurístico |
| Q8 | Auditoria **só** no log de sessão (`bmpp/policy`), por ora — relatório derivado é opcional e fora do MVP |

### Ainda abertas (dependem de você)

Q1–Q8 estão **resolvidas** (tabela acima). Restam as três abaixo, todas relativas à etapa de Git
(§25) e ao shape do pacote.

**Q9 — Nome da branch principal e política de branches do BMPP.** A fundação está em `main`
(rev. 3). Confirmar `main` como branch padrão e se cada fase do §27 usa uma branch própria ou
commits diretos em `main`.

**Q10 — Identidade do commit.** O repositório do BMPP é novo e não tem autor configurado. Definir
`user.name`/`user.email` para os commits do BMPP (e, se o projeto for público, se devem ser os
mesmos do DSH ou uma identidade própria).

**Q11 — Quando o pacote deixa de ser privado.** O nome é `dsh-bmpp` (neutro, sem o escopo
`@deepseek-ai`, que pertence ao projeto DSH) e o `package.json` está com `private: true` para
impedir publicação acidental. Definir quando (e se) ele passa a ser publicável — e se o nome
`dsh-bmpp` está disponível no registry.

**Q12 — Detentor do copyright na licença.** `LICENSE` está como "BMPP contributors". Confirmar se
esse texto permanece ou se deve nomear uma pessoa/organização.

---

## 25. Versionamento Git (etapa prévia à Fase 1)

**Regra:** nada de Git acontece sem autorização explícita do usuário. O estado atual foi apenas
**inspecionado** (somente leitura) e está registrado abaixo.

### 26.1 Estado encontrado (inspeção read-only, rev. 2)

| Comando | Resultado |
|---|---|
| `git remote -v` | `origin  https://github.com/deepseek-ai/deepseek-harness.git` (**fetch** e **push**) — remote oficial/upstream confirmado, e é o **único** |
| `git branch --show-current` | `master` |
| `git status --short --branch` | `## master...origin/master` — **sem** arquivos modificados, **sem** untracked, **sem** staged |
| `git log -1 --oneline` | `c291e7961a Merge pull request #3977 from deepseek-harness/worktree/release-0.1.5-sync-master` (2026-09-10) |
| `git rev-parse --show-toplevel` | `<dsh-checkout>` |
| Tipo de checkout | `.git` é **diretório** → clone Git normal (não worktree, não submodule) |
| Branches locais | apenas `master`, rastreando `origin/master` |
| Alterações locais | **nenhuma** (`git status --porcelain` retorna 0 linhas) |
| Stash | vazio |
| Shallow | não (`.git/shallow` inexistente); 16.511 commits |
| Upstream do branch atual | `origin/master` |
| Gitignore relevante | `node_modules/`, `lib/` — `packages/**` **é versionado** |

### 26.2 Leitura do estado

- **O checkout está limpo e é um clone normal do upstream oficial.** Não há trabalho local não
  commitado em risco, não há stash, não há branch paralela, não há remote extra.
- Isso significa que criar a branch do BMPP é seguro e trivial — **e** que qualquer `pnpm install`
  ou build rodado antes disso produziria sujeira que hoje não existe.
- `lib/` é ignorado pelo Git, então artefatos de build do BMPP não entram no versionamento.
- Não existe, hoje, nenhum diretório `packages/bmpp/` (nada a remover ou sobrescrever) — e, pela
  rev. 3, nunca existirá: o BMPP é um projeto standalone em `<workspace>/bmpp/`.
- O Git do BMPP é **completamente independente**: `git init` foi executado apenas em
  `<workspace>/bmpp/`, e o checkout do DSH permanece exatamente no estado acima.

### 26.3 Comandos que permanecem proibidos sem autorização explícita

`git reset` · `git clean` · `git checkout` destrutivo · `git remote add` · `git push` · `git commit`.

Nenhum deles foi executado. Nenhum será, até sua autorização — que é exatamente a próxima etapa
combinada.

### 26.4 Sequência proposta (para sua aprovação)

1. Criar a branch de trabalho a partir de `master` (`c291e7961a`) — nome em Q9.
2. Confirmar a identidade de commit (Q10).
3. Só então iniciar a Fase 1 (implementação em `<workspace>/bmpp/`), com commits pequenos por fase.
4. `push` **somente** se você autorizar; nenhuma alteração será enviada ao `origin` sem isso.

---

## 26. Discrepâncias entre o prompt e a implementação real

| O prompt sugere | Realidade verificada | Alternativa compatível adotada |
|---|---|---|
| "hook `pre-execute`" | o seam existe e se chama **`tools/pre-execute`** (waterfall, `PreToolDecision`); `PreToolUse` é só o nome do ponto Claude Code, mapeado para ele pelo bridge | usar `tools/pre-execute` + `ctx.tools.guard()` |
| "o plugin pré-injeta contexto de memória" (limitação nº 1 registrada antes) | **não** é possível: `PreToolDecision` não reescreve argumentos e não há injeção no pipeline de ferramenta | o BMPP **nega com instrução**; injeção (se desejada) só via `agent.inject`/`agent/pre-step`, fora do gate → Q4 |
| "20 regras" na suíte existente | `policy_verify.py` implementa **12 cenários** com um conjunto de asserções nomeadas (`policy_injected`, `first_tool_memory`, `memory_search_before_other_tools`, `no_writes`, `writes_allowed`, `first_tool_bash`, …), não 20 regras numeradas | preservar os 12 cenários como regressão e **nomear** as asserções na nova suíte; a contagem "20" do pedido é atendida pelos 20 cenários de teste do §15.2 |
| "search_notes precisa ser a primeira chamada" | é incompatível com o pipeline (leitura e classificação podem preceder) e frágil sob paralelismo | substituída pela **precondição** de recall (§10.2) |
| "classificação via metadados do ciclo de vida" | não existe campo semântico em `agent/session-start`, `turn/start` ou `agent/pre-step` | opção A+D: `bmpp__classify` + default conservador |
| "o plugin deve detectar duplicatas" | annotations MCP (`readOnlyHint`) **não** chegam ao `ToolDefinition`; não há API de "títulos existentes" | tabela estática das 21 ferramentas + detecção só do que é mecanicamente observável (§17) |
| "cache pode ser invalidado" | o cache Redis **existe mas está desligado** (`redis_url: null`); mesmo ligado, a invalidação é best-effort por TTL | documentar, não contornar; nunca escrever duas vezes (§4.2) |
| "registrar o plugin no DSH" como parte do trabalho | **não** será feito nesta fase; depende de autorização | §27 (Fase 4) |

Acrescentadas na rev. 2 (decisões do usuário que **corrigem** a proposta inicial da rev. 1):

| A rev. 1 propunha | Decisão da rev. 2 |
|---|---|
| default `mode: enforce` | **default `mode: audit`** + `profile: compat` — observa e audita primeiro |
| booleano/preset `strict mode` | **`profile: compat \| strict`** ortogonal a `mode`, sem booleano |
| candidato a `gateScope` configurável | **removido**: escopo fixo no Basic Memory no MVP |
| `ask` para destrutivas como opção geral | `ask` **somente** em `enforce` + `strict` |
| rev. 2 propunha o plugin dentro do checkout do DSH | **Rev. 3: projeto standalone em `<workspace>/bmpp/`**, com Git próprio; o checkout do DSH permanece clone oficial, sem fork |
| `bmpp__classify` como primeira ação | **em qualquer ponto** do turno |

---

## 27. Plano de implementação em fases

### Fase 0 — Aprovação e preparação do Git (esta entrega + próxima)

- Documento revisado + gate A–G. **Nada é alterado no sistema.** Parada obrigatória.
- Em seguida, **com autorização explícita**: criar a branch de trabalho (§25) — sem `commit`,
  sem `push`, sem tocar o remote.

### Fase 1 — Esqueleto e L1 (sem tocar produção)

- Implementar sobre a fundação já criada em `<workspace>/bmpp/` (rev. 3), seguindo a convenção
  `name`/`inject`/`apply` estabelecida em `src/index.ts`.
- Config com `mode`/`profile` normalizados (§13.3), incluindo o `superRefine` que rejeita
  combinações ambíguas.
- Confirmar empiricamente a resolução do bare specifier no perfil (§23).
- Implementar a state machine pura (`decide(state, call) → {decision, reasonCode, event}`),
  testável sem DSH.
- Registro do gate em `tools/pre-execute` + `tools/result` + reset em `turn/start`/`session-start`.
- Tool `bmpp__classify`.
- Suíte L1: cenários 1, 3, 6, 7, 8, 9, 11, 12, 16, 18, 19, 22, 23.
- **Critério de saída:** L1 verde; nenhuma linha de produção DSH alterada; plugin não montado.

### Fase 2 — Integração no pipeline (L2)

- Montar em um `Context` de teste com `ToolRuntime` real, ferramentas fixture, e afirmar
  allow/deny/isError.
- Cenários 4, 5, 10, 13, 14, 17, 21, 24 (inclui `mode: audit` não bloqueando e `ask` só em `strict`).
- `session.append('bmpp/policy', …)` com o schema do §13.
- **Critério de saída:** L2 verde; eventos auditáveis no log de teste.

### Fase 3 — End-to-end no agent-loop (L3)

- Padrão `interception.spec.ts` com `MockAdapter`: o modelo recebe o erro e se recupera.
- Cenários 2, 3, 4 na forma end-to-end.
- **Critério de saída:** L3 verde; `policy_verify.py` continua 0 falhas (cenário 20).

### Fase 4 — Montagem no perfil real (default aprovado)

- Linha no `cordis.patch.yml` com **`mode: audit` + `profile: compat`** (o default aprovado, rev. 2).
- Rodar turnos reais; inspecionar `bmpp/policy`.
- Comparar: `policy_verify.py policy_spec.json` → 0 falhas.
- **Critério de saída:** nenhuma diferença de comportamento observável; auditoria completa.

### Fase 5 — `enforce`

- Ligar **`mode: 'enforce'` + `profile: 'compat'`** (guards secundários ainda em `warn`).
- Repetir a suíte E2E + os 12 cenários.
- Medir falso bloqueio em uso real por alguns turnos.
- **Critério de saída:** nenhum falso bloqueio; suíte integral verde.

### Fase 5b — Avaliação de `profile: 'strict'` (separada e reversível)

- Trocar **uma linha** para `profile: 'strict'`: `overwriteRequiresRead`, `secretPatternGuard` e
  `testFixtureGuard` sobem para `deny`; destrutivas passam a pedir `ask`.
- Reavaliar falso bloqueio com atenção ao guard de segredo (heurístico).
- **Critério de saída:** decisão registrada sobre manter `strict` ou voltar a `compat` — reverter é
  uma linha, não um rollback de código.

### Fase 6 — Integração L4 contra o Basic Memory real

- Montar com o servidor real: confirmar as 21 ferramentas, os nomes públicos, o comportamento de
  `isError`, o retorno vazio, `move_note` e o fluxo `archive/`.
- Cenários 13, 14, 15.
- **Critério de saída:** cenários L4 verdes; limitações de consistência confirmadas como
  documentadas.

### Fase 7 — Fechamento

- `AGENTS.md`: +1 linha conectando Gate 1 ao BMPP; nota de política ganha seção "enforcement".
- Script de auditoria (ler `bmpp/policy` do log) — opcional, conforme Q8.
- Registrar tudo na memória (notas `Projects/`, `Instructions/`, `Learnings/`).
- **Critério de saída:** um comando responde "por que esta chamada foi bloqueada?".

---

## Apêndice A — Resumo do que o BMPP responde mecanicamente

| Pergunta | Resposta mecânica |
|---|---|
| "Esta tarefa exigia consulta à memória?" | evento `bmpp/policy` com `classification ∈ {complex, unknown}` no turno |
| "A consulta obrigatória foi realizada?" | evento `toolClass:'memory.read'` com `recall.state ∈ {ok, empty}` no mesmo turno |
| "Por que esta chamada foi permitida?" | `decision:'allow'` + `reasonCode` (`ALLOW_SIMPLE`, `ALLOW_READ_ONLY`, `ALLOW_RECALL_OK`, …) |
| "Por que esta chamada foi bloqueada?" | `decision:'deny'` + `reasonCode` + `policyState` |
| "O estado foi resetado corretamente?" | evento `action:'turn.reset'` no `turn/start` seguinte |
| "O comportamento pode ser reproduzido nos testes?" | as mesmas afirmações rodam em vitest (20 cenários) e no verifier legado (12 cenários) |
