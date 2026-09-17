# BMPP — Basic Memory Policy Plugin para o DeepSeek Harness

Um plugin nativo do [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) que
move a parte **mecanicamente verificável** da política de memória de um agente para dentro do
runtime, deixando toda decisão **semântica** para o modelo.

> **Status: experimental / alpha.** O BMPP funciona e é coberto por uma suíte de testes automatizada,
> mas sua API e seu modelo de configuração ainda podem mudar entre releases. Não é um produto
> endurecido para produção e não é afiliado nem endossado pelo projeto DeepSeek.

---

## O que é o BMPP?

Um agente que usa um sistema de memória tem uma política para ele: *busque antes de escrever*, *não
duplique uma nota existente*, *não confie num valor recuperado sem checar o sistema vivo*. Parte
dessa política só o modelo pode julgar — se uma memória vale a pena guardar, se uma nota já cobre o
assunto, se um fato recuperado ainda é verdadeiro. **O BMPP não toca nessa parte.** Ele deixa o
julgamento semântico onde ele pertence e nunca lê o conteúdo das notas nem o texto do usuário.

O resto da política é mecânico: *uma busca de memória realmente terminou antes desta escrita?* *essa
busca falhou?* *esta é a mesma escrita duas vezes no mesmo turno?* Essas perguntas são respondidas
por eventos que o runtime já emite, então o BMPP as decide de forma determinística e as impõe.

O BMPP fica entre o modelo e as ferramentas
[`mcp__basic-memory__*`](https://github.com/basicmachines-co/basic-memory). Quando o modelo tenta
alterar a memória, o BMPP checa as precondições e deixa a chamada passar ou a bloqueia com uma
explicação que o modelo consegue seguir.

**Escopo:** o BMPP governa apenas o namespace `mcp__basic-memory__*`. Ele não bloqueia `bash`,
`edit`, `write`, o filesystem nem qualquer outra ferramenta, e não é uma política de segurança geral
para agentes.

---

## Como funciona

Todo turno tem uma **classificação**, e o gate do BMPP é função dela.

| Classificação | Significado | Efeito em escritas de memória | Efeito em leituras |
|---|---|---|---|
| `unknown` | o modelo ainda não declarou nada | **bloqueada** | permitida |
| `simple` | o modelo declarou o turno trivial | **permitida**, sem exigir busca | permitida |
| `complex` | o modelo declarou que o turno precisa de memória | **permitida só após uma busca bem-sucedida no mesmo turno** | permitida |

O modelo declara a classificação com a ferramenta de controle do próprio BMPP, `bmpp__classify`:

```json
{"task": "complex"}
```

Ela pode ser chamada em qualquer ponto do turno — não precisa ser a primeira chamada — e um turno que
nunca declara nada permanece `unknown`, o que permite leituras e bloqueia escritas.

**Recall.** Num turno `complex`, o BMPP observa as ferramentas de busca
(`search_notes`, `search`, `build_context`). Uma busca concluída com sucesso satisfaz a precondição
de recall; uma busca que falha mantém o gate fechado e o modelo é instruído a tentar de novo. O BMPP
não interpreta o conteúdo do resultado — ele lê o sinal estruturado de erro que o runtime já fornece,
então um resultado honestamente vazio continua contando como busca concluída.

**O gate de mutação.** Uma escrita de memória é checada, em ordem, contra:

1. a classificação (`unknown` → bloqueada);
2. se uma busca foi concluída, e se teve sucesso;
3. se uma busca e uma escrita foram agrupadas no mesmo lote paralelo;
4. se uma nota existente está sendo sobrescrita sem ter sido lida antes.

Toda decisão carrega um **reason code** estável (`CLASSIFICATION_REQUIRED`, `CREATE_REQUIRES_SEARCH`,
`MEMORY_LOOKUP_REQUIRED`, `MEMORY_LOOKUP_FAILED`, `MEMORY_LOOKUP_PENDING_IN_BATCH`,
`OVERWRITE_REQUIRES_READ`, …) para que uma chamada bloqueada seja explicada em vez de engolida.

**Ciclo de vida do turno.** O estado do BMPP é por sessão e por turno. Quando o turno do Harness
avança, a classificação e o estado de recall do turno anterior são descartados, então uma autoridade
conquistada num turno nunca é reutilizada no seguinte. Sessões que o BMPP não julgou não são
afetadas de forma alguma.

---

## Modos

`mode` decide se o veredito é *aplicado* ou apenas *registrado*.

| Modo | Decide | Aplica | Pode negar ou pedir aprovação? |
|---|---|---|---|
| `off` | não | não | não — não registra nada |
| `audit` | sim | não | **nunca** — toda chamada prossegue, e a negação que ele queria é registrada |
| `enforce` | sim | sim | sim — é o único modo que bloqueia |

**`audit` nunca bloqueia, qualquer que seja o profile.** É o primeiro passo seguro: você obtém a
evidência completa do que o BMPP *teria* feito, sem nenhuma mudança de comportamento.

## Profiles

`profile` decide quão rigorosa é a política. Ele nunca altera `mode`.

| Profile | Efeito |
|---|---|
| `compat` | guards secundários apenas avisam; operações destrutivas passam pelo gate normal |
| `strict` | guards secundários negam; operações destrutivas pedem aprovação em vez de negar direto |

Apenas três opções diferem entre os profiles. Todo o resto — incluindo quando `unknown` bloqueia
escritas e quando criar exige busca — é idêntico nos dois.

**Padrões: `mode: audit` + `profile: compat`.**

---

## Versões do DSH suportadas

```
BMPP 0.1.0  →  DSH >= 0.1.5-rc.2 < 0.2.0
```

| | |
|---|---|
| Faixa | `>=0.1.5-rc.2 <0.2.0` |
| Verificadas | `0.1.5-rc.2`, `0.1.6-alpha.1` |

A compatibilidade é declarada como um envelope explícito em `package.json` (`dsh.compatibility`) e em
`src/version.ts`. Ao carregar, o BMPP detecta a versão do Harness em execução e a classifica:

- **dentro da faixa** → ativa (uma versão dentro da faixa mas ausente da lista de verificadas é
  reportada como "dentro da faixa, não verificada");
- **fora da faixa** (mais antiga ou mais nova) → recusa carregar, com o motivo concreto;
- **indetectável** → ativa e informa isso.

A lista `verified` é *evidência*, não uma segunda barreira — acrescentar uma versão a ela não muda
comportamento nenhum, só o status reportado. O BMPP também sonda o serviço `tools` injetado pelos
métodos exatos contra os quais ele programa, então um Harness que mudou a superfície do registro de
ferramentas falha alto no carregamento em vez de aplicar a política errada depois.

Estratégia completa em [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

---

## Instalação

O BMPP é um **bundle** do DSH (um pacote cujo `package.json` declara `dsh.bundle.patch`), e também
pode ser carregado sem instalar nada.

### Experimentar sem instalar

Um overlay `--patch` contribui apenas com configuração, então um checkout não instalado pode ser
carregado por caminho absoluto — nada é escrito num profile:

```sh
dsh --profile bmpp-dev --patch /caminho/absoluto/para/bmpp/overlay.dev.cordis.yml "<tarefa>"
```

O overlay é local à máquina e está no gitignore. `examples/` traz trechos de configuração
distribuíveis.

### Instalar num profile

```sh
# a partir de um checkout local ou de um tarball empacotado
pnpm run build && pnpm pack
dsh plugin --profile <profile> add ./dsh-bmpp-0.1.0.tgz
```

`dsh plugin add` roda o pnpm dentro do profile, linka o pacote e acrescenta o bundle à lista ordenada
de bundles do profile. O BMPP **ainda não está publicado em nenhum registro de pacotes**, então hoje
a instalação é por caminho local ou tarball.

Mecanismo, alternativas e o raciocínio por trás da forma de bundle:
[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

---

## Configuração

Duas dimensões independentes, configuradas numa única linha. Não existe um booleano `strict` nem uma
segunda forma de configurar a mesma coisa.

```yaml
- insert:
    - id: bmpp
      name: 'dsh-bmpp'
      config:
        mode: audit        # off | audit | enforce
        profile: compat    # compat | strict
```

O schema rejeita chaves desconhecidas e valores inválidos no carregamento, então um erro de digitação
falha o boot em vez de desativar um guard silenciosamente.

`examples/` tem um trecho pronto por combinação: `config.off.yml`, `config.audit.yml`,
`config.enforce.yml`, `config.strict.yml`.

---

## Exemplos

**Um turno que nunca se classifica → escritas bloqueadas, leituras não.**

```
modelo: mcp__basic-memory__read_note   { identifier: "alguma-nota" }
        → permitida          (leituras nunca são bloqueadas)

modelo: mcp__basic-memory__write_note  { title: "Nota nova", … }
        → negada             CLASSIFICATION_REQUIRED
        → "this turn has not been classified … call bmpp__classify first"
```

**Um turno `simple` → escritas permitidas sem nenhuma busca.**

```
modelo: bmpp__classify                 { task: "simple" }
        → permitida          ALLOW_CONTROL

modelo: mcp__basic-memory__write_note  { title: "Nota nova", … }
        → permitida          ALLOW_SIMPLE
```

**Um turno `complex` que escreve sem buscar → bloqueado.**

```
modelo: bmpp__classify                 { task: "complex" }
        → permitida          ALLOW_CONTROL

modelo: mcp__basic-memory__write_note  { title: "Nota nova", … }
        → negada             CREATE_REQUIRES_SEARCH
        → "creating a note requires searching for the subject first … Search, then retry."
```

**Um turno `complex` que busca primeiro → a escrita é permitida.**

```
modelo: bmpp__classify                  { task: "complex" }
        → permitida          ALLOW_CONTROL

modelo: mcp__basic-memory__search_notes { query: "…" }
        → permitida          ALLOW_READ_ONLY
        → recall settled: succeeded

modelo: mcp__basic-memory__write_note   { title: "Nota nova", … }
        → permitida          ALLOW_RECALL_OK
```

> Em `mode: audit`, cada linha "negada" acima é registrada como negação e **ainda assim permitida**.
> Bloqueio real exige `mode: enforce`.

---

## Arquitetura

O BMPP é um plugin Cordis registrado pela API pública de plugins do Harness. Ele consome o Harness
como dependência e nunca faz fork dele.

| Peça | Papel |
|---|---|
| `src/state.ts` | a **máquina de estados pura da política**: `decide()` devolve o veredito, o motivo e um evento de decisão. `mode` e `profile` estão deliberadamente ausentes das suas entradas, então a máquina não pode ser influenciada por configuração de enforcement. |
| `src/gate.ts` | a **camada de integração**: assina `tools/pre-execute` e `tools/result`, resolve o turno atual, aplica `mode`/`profile` *depois* do veredito e registra a ferramenta de controle `bmpp__classify`. |
| `src/config.ts` | o modelo validado `mode` × `profile` e as listas de classes de ferramenta. |
| `src/version.ts` | a linha de versão do próprio BMPP e o envelope de compatibilidade, detecção e classificação. |
| `src/audit-sink.ts`, `src/audit-store.ts` | o schema do registro de auditoria e o armazenamento durável em sidecar. |
| `src/index.ts` | a entrada Cordis: validação de configuração, sonda de superfície no carregamento, decisão de compatibilidade e montagem. |

**Interceptação de ferramentas.** O BMPP classifica uma chamada pelo nome da ferramenta que já
recebe. Chamadas fora do namespace de memória são delegadas intactas; leituras são permitidas;
escritas e operações destrutivas passam pelo gate. Ele inspeciona argumentos apenas na medida em que
um guard precisa (um caminho alvo e um flag `overwrite`), e nunca o conteúdo da nota.

**Ciclo de vida do turno.** O turno atual do Harness é lido do serviço `sessionProjections` quando o
host oferece um, e de um contador interno caso contrário. Avançar o turno descarta a classificação e
o estado de recall do turno anterior.

**Detecção da versão do host.** O Harness não expõe serviço de versão no seu contexto, então o BMPP
lê a versão do **manifesto da aplicação que o hospeda** — o `package.json` do entry point em
execução — e recorre a um pacote de identidade do Harness resolvido a partir desse entry. Ancorar no
entry point importa: resolver a partir do próprio módulo do BMPP leria a dependência *do próprio*
BMPP e reportaria a dependência de desenvolvimento como a versão do host.

**Nenhum import de valor do Harness.** Todo import `@deepseek-ai/*` no código emitido é import de
tipo e é apagado na compilação; o acesso em runtime é pelo contexto injetado. Um teste verifica isso
contra o JavaScript emitido, e é o que torna o BMPP genuinamente standalone em vez de um fragmento
do monorepo do Harness.

---

## Auditoria

O BMPP registra toda decisão — o veredito, seu reason code, a classe da ferramenta, o estado da
política, o desfecho de enforcement, o turno e a classificação. Registra **apenas metadados**: sem
argumentos de ferramenta, sem conteúdo de nota, sem texto do usuário.

**A auditoria não é escrita no log de eventos de sessão do DSH.** Ela fica num sidecar de
armazenamento: um domínio próprio do plugin (`bmpp_audit`, versão 1, layout por registro) aberto pelo
serviço público `storageDomain` do Harness, que o guarda em `$DSH_HOME/storages/bmpp_audit/`.

Isso importa por um motivo concreto. Um tipo de evento de sessão que o Harness não conhece é
*obrigatório na leitura*: um leitor que encontra um evento não reconhecido precisa recusar reconstruir
a sessão em vez de pulá-lo em silêncio, e a API pública `Session.append` não oferece meio de um plugin
marcar o próprio tipo de evento como seguro de omitir. Escrever um tipo inventado pelo plugin no log
de sessão, portanto, tornava toda sessão auditada não observável e não retomável. Manter a auditoria
no seu próprio domínio deixa o log de sessão interpretável por qualquer build do Harness, e mantém a
auditoria durável e consultável.

Armazenamento é uma dependência **opcional**. Se uma composição não monta serviço de armazenamento, o
BMPP continua impondo todas as regras e reporta os registros que não conseguiu persistir; uma falha de
log nunca vira uma falha de política, e uma auditoria que falha nunca transforma um allow em deny.

---

## Limitações

Limitações honestas do estado atual:

- **Experimental.** O modelo de configuração e o vocabulário de reason codes ainda podem mudar.
- **Somente Basic Memory.** O gate governa `mcp__basic-memory__*` e nada mais.
- **Leituras nunca são bloqueadas.** O BMPP não tem noção de leitura proibida.
- **O desfecho de recall é `ok` ou `failed`.** O Basic Memory não anuncia schema de saída para suas
  ferramentas de busca, então uma busca *vazia mas bem-sucedida* é indistinguível de uma populosa. O
  BMPP se recusa a interpretar o texto do resultado para adivinhar; `RECALL_EMPTY` permanece modelado
  mas inalcançável.
- **Guards secundários parciais.** O guard de sobrescrita-sem-leitura está implementado. Os guards de
  padrão de segredo e de fixture de teste estão modelados e configuráveis, mas ainda não são impostos.
- **A camada de regressão em Python está obsoleta.** `tools/emit-policy-stream.mts` e
  `tools/bmpp_verify.py` foram escritos para um desenho anterior, no qual a auditoria era um evento de
  sessão `bmpp/policy`. Desde que a auditoria passou para o sidecar, essa camada não lê evento nenhum
  e não verifica nada. As suítes TypeScript são hoje a verificação autoritativa.
- **Não é um sandbox nem uma fronteira de segurança.** O BMPP impõe uma política de memória; ele não
  confina um agente.

---

## Desenvolvimento

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build    # emite lib/, que nunca é versionado
```

Requer Node.js `^22.19.0 || >=24.0.0` e pnpm. O `pnpm test` também compila o projeto, porque uma
suíte inspeciona o JavaScript emitido para provar que o plugin não importa nenhum valor do Harness.

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para como propor mudanças.

---

## Desenvolvimento assistido por IA

O BMPP é desenvolvido com fluxos assistidos por IA, incluindo implementação, testes, depuração e
documentação assistidas por LLM, em estilo iterativo ("vibe coding"). Isso é dito abertamente porque
é verdade e porque é relevante para como você deve avaliar o projeto.

Não é oferecido como garantia de qualidade em nenhuma direção. O que o projeto usa no lugar disso é
comportamento verificável: uma suíte de testes que exercita o registro real de ferramentas, um
envelope de compatibilidade que falha alto em vez de aplicar a política errada em silêncio, e as
limitações documentadas acima. Trate os testes, não a prosa, como a alegação.

---

## Segurança

Veja [SECURITY.md](SECURITY.md) para como reportar uma vulnerabilidade. Por favor não abra uma issue
pública para um problema de segurança.

## Contribuição

Veja [CONTRIBUTING.md](CONTRIBUTING.md). Contribuições são bem-vindas, incluindo issues sobre
comportamento que você considere errado na política.

## Licença

MIT — veja [LICENSE](LICENSE).

O BMPP é um plugin independente de terceiros. Não faz parte do repositório do DeepSeek Harness e não
é afiliado nem endossado pelo projeto DeepSeek.

---

## English

An English version of this README is at [README.md](README.md).
