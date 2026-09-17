#!/usr/bin/env node
/**
 * Emit a real BMPP policy decision stream for independent verification.
 *
 * This is a verification tool, not a test: it mounts the actual plugin through
 * the real Cordis/tool pipeline, drives a fixed script of scenarios through it,
 * and writes the resulting `bmpp/policy` events as JSONL. `tools/bmpp_verify.py`
 * then checks those events from outside TypeScript.
 *
 * Why a separate layer: the Vitest suite proves the plugin's decisions; this
 * stream lets a reader check the DURABLE record — the codes, the classifications
 * and the recall states that actually reached the session log — with a tool that
 * shares no code with the implementation.
 *
 * Two scenarios belong to the batch scheduler and cannot be reproduced without
 * the agent loop, which is covered by `tests/integration/scheduler.spec.ts`.
 * Their invariant is still checked in Python against the same rule set, using a
 * synthetic line, so the rule cannot rot.
 *
 * Usage:
 *   node --import tsx/esm tools/emit-policy-stream.mts [output.jsonl]
 *
 * @module tools/emit-policy-stream
 */

import { writeFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'

const SERVER = 'basic-memory'
const publicName = (raw: string): string => `mcp__${SERVER}__${raw}`

const SEARCH = publicName('search_notes')
const MOVE = publicName('move_note')
const WRITE = publicName('write_note')
const DELETE = publicName('delete_note')
const CLASSIFY = 'bmpp__classify'
const UNKNOWN_TOOL = publicName('a_tool_that_does_not_exist')

const RAW_TOOLS = [
  'search_notes', 'move_note', 'write_note', 'delete_note', 'edit_note',
  // Registered on purpose: the gate must see a tool the POLICY does not
  // classify, which is different from a tool the registry does not know.
  'a_tool_that_does_not_exist',
  'read_note', 'recent_activity', 'delete_project', 'create_memory_project',
  'build_context', 'search', 'fetch', 'view_note', 'read_content',
  'list_directory', 'list_memory_projects', 'list_workspaces',
  'schema_infer', 'schema_validate', 'schema_diff', 'basic_memory_diagnostics',
]

/**
 * The script the emitter walks: each step is one scenario.
 *
 * Every scenario gets its OWN context, session and gate, so the stream records
 * independent decisions. Sharing one session would let a recall earned in an
 * earlier scenario satisfy a later one, which would make the stream useless as
 * evidence.
 */
const scenarioNames: string[] = []
const scenarioRuns: ((world: World) => Promise<void>)[] = []

/** Record one scenario in the stream. */
function scenario(name: string, run: (world: World) => Promise<void>): void {
  scenarioNames.push(name)
  scenarioRuns.push(run)
}

scenario('unknown-turn-blocks-mutation', async (world) => {
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T.md' })
})

scenario('simple-turn-releases', async (world) => {
  await world.call(CLASSIFY, { task: 'simple' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T.md' })
})

scenario('complex-without-lookup-is-blocked', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T2.md' })
})

scenario('move-without-lookup-needs-recall', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
})

scenario('complex-with-lookup-releases', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(SEARCH, { query: 'note' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T3.md' })
})

scenario('failed-lookup-does-not-release', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  world.failNextSearch()
  await world.call(SEARCH, { query: 'failing' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T4.md' })
})

scenario('retry-after-failure-recovers', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  world.failNextSearch()
  await world.call(SEARCH, { query: 'failing-again' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T5.md' })
  await world.call(SEARCH, { query: 'retry' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T5b.md' })
})

scenario('empty-result-counts-as-ok', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(SEARCH, { query: 'nothing-matches' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T6.md' })
})

scenario('unknown-memory-tool-fails-closed', async (world) => {
  // No classification: the turn is UNKNOWN, and an unlisted memory tool must
  // fail closed exactly like a listed write.
  const denied = await world.call(UNKNOWN_TOOL, { whatever: true })
  if (!denied) throw new Error('the unlisted memory tool was allowed')
})

scenario('unknown-memory-tool-fails-closed-when-classified', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  const denied = await world.call(UNKNOWN_TOOL, { whatever: true })
  if (!denied) throw new Error('the unlisted memory tool was allowed on a COMPLEX turn')
})

scenario('move-is-not-destructive', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(SEARCH, { query: 'note' })
  await world.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
  await world.call(DELETE, { identifier: 'Note' })
})

scenario('move-destinations-are-distinct', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(SEARCH, { query: 'note' })
  await world.call(MOVE, { identifier: 'Note', destination_path: 'archive/A.md' })
  await world.call(MOVE, { identifier: 'Note', destination_path: 'archive/B.md' })
  await world.call(MOVE, { identifier: 'Note', destination_folder: 'archive' })
  await world.call(MOVE, { identifier: 'Note', destination_path: 'archive/A.md' })
})

scenario('classification-can-arrive-late', async (world) => {
  await world.call(publicName('read_note'), { identifier: 'x' })
  await world.call(CLASSIFY, { task: 'simple' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T7.md' })
})

scenario('reclassification-latest-wins', async (world) => {
  await world.call(CLASSIFY, { task: 'complex' })
  await world.call(CLASSIFY, { task: 'simple' })
  await world.call(WRITE, { title: 'T', content: 'c', directory: 'D', file_path: 'N/T8.md' })
})

/** Build one isolated world: its own context, session and gate. */
async function makeWorld(): Promise<{ world: World; dispose: () => Promise<void> }> {
  const received = new Map<string, Record<string, unknown>[]>()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)

  // `enforce` + `strict`: the strictest combination, so the stream shows real
  // denials and the destructive/non-destructive distinction.
  const report = apply(ctx, { mode: 'enforce', profile: 'strict', policyVersion: '0.1.0' })
  if (report.gate === undefined) throw new Error('the gate did not mount')

  const session = ctx.sessions.create(SessionId('policy-stream'))
  const agent = { session } as unknown as never
  let failNextSearch = false

  for (const raw of RAW_TOOLS) {
    const name = publicName(raw)
    ctx.tools.register({
      name,
      description: `emitter fixture ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      output: {
        schema: { type: 'object', properties: { content: { type: 'array' } }, required: ['content'] },
        render: (_a: unknown, value: unknown) =>
          ((value as { content?: { type: 'text'; text: string }[] }).content ?? []),
      },
      async execute(args: unknown): Promise<unknown> {
        const parsed = (args ?? {}) as Record<string, unknown>
        const log = received.get(raw) ?? []
        log.push(parsed)
        received.set(raw, log)
        if (raw === 'search_notes' && failNextSearch) {
          failNextSearch = false
          throw new Error('memory backend unavailable')
        }
        return { content: [{ type: 'text', text: raw === 'search_notes' ? 'No results found' : 'ok' }] }
      },
    })
  }

  const policyEvents = (): readonly Record<string, unknown[]>[] =>
    session.snapshotEvents()
      .filter(event => event.type === 'bmpp/policy')
      .map(event => event.data as unknown) as never

  const world: World = {
    ctx,
    received,
    events: () => policyEvents() as never,
    failNextSearch: () => { failNextSearch = true },
    async call(name, args = {}) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`emit-${name}-${Math.random().toString(36).slice(2, 8)}`),
        name,
        arguments: args,
        agent,
      })
      return result.isError
    },
  }
  return { world, dispose: async () => { await ctx.fiber.dispose() } }
}

/**
 * Run every scenario in its own world and write the policy stream.
 *
 * @param outputPath - where the JSONL stream is written.
 */
async function main(outputPath: string): Promise<void> {
  const lines: string[] = []
  for (const [index, name] of scenarioNames.entries()) {
    lines.push(JSON.stringify({ type: '@scenario', name }))
    const { world, dispose } = await makeWorld()
    try {
      await scenarioRuns[index]!(world)
      for (const event of world.events()) {
        lines.push(JSON.stringify({ type: 'bmpp/policy', scenario: name, data: event }))
      }
    } finally {
      await dispose()
    }
  }
  writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`wrote ${lines.length} lines to ${outputPath}\n`)
}

const target = process.argv[2] ?? 'tools/policy-stream.jsonl'
await main(target)
