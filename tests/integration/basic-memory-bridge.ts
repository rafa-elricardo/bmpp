/**
 * An MCP-shaped bridge: the 21 real Basic Memory tools, served locally.
 *
 * The registrations mirror what `@deepseek-ai/dsh-mcp-client` does when it
 * bridges a server: one `ToolDefinition` per advertised tool, registered under
 * `mcp__<serverName>__<rawName>`, whose `execute` performs a `tools/call` and
 * whose canonical value is the MCP result `{ content, structuredContent? }`.
 *
 * The handlers are local fixtures — **nothing here touches a knowledge base**.
 * A test supplies the outcome it needs, so the contract can be exercised without
 * a server, and no note is ever read or written.
 *
 * Registered through the real DSH `ToolRuntime`, so the assertions are about the
 * actual registry and pipeline, not a stand-in.
 *
 * @module tests/integration/basic-memory-bridge
 */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { apply, type BmppLoadReport } from '../../src/index.ts'
import { BASIC_MEMORY_CATALOG, publicName, type CatalogEntry } from './basic-memory-catalog.ts'
import { auditDomainDouble } from '../support/audit-domain.ts'

/**
 * What one fixture `tools/call` returns.
 *
 * `text` mirrors the MCP server's text blocks. `isError` mirrors the protocol
 * flag the bridge turns into a thrown error, which the registry then reports to
 * the model as an `isError` tool result — the only structured signal BMPP gets
 * about a recall.
 */
export interface ToolOutcome {
  readonly text: string
  readonly isError?: boolean
  /** Raw arguments the fixture received, for argument-contract assertions. */
  readonly meta?: Record<string, unknown>
}

/** A fixture handler for one tool. */
export type ToolHandler = (args: Record<string, unknown>) => ToolOutcome | Promise<ToolOutcome>

/** Options for {@link mountBridge}. */
export interface BridgeOptions {
  /** BMPP configuration; defaults to `mode: enforce` + `profile: compat`. */
  readonly bmpp?: Record<string, unknown>
  /** Per-tool fixtures, keyed by RAW MCP tool name. */
  readonly handlers?: Readonly<Record<string, ToolHandler>>
}

/** A mounted bridge over the real registry. */
export interface Bridge {
  readonly ctx: Context
  readonly report: BmppLoadReport
  readonly session: Session
  /** The real `ToolDefinition` the registry holds for one public name. */
  definition(publicToolName: string): ToolDefinition | undefined
  /** Arguments each fixture received, keyed by raw tool name. */
  readonly received: Map<string, Record<string, unknown>[]>
  /** Execute one tool through the real pipeline. */
  call(publicToolName: string, args?: Record<string, unknown>): Promise<ToolExecutionResult>
  /** Every `bmpp/policy` payload the gate wrote, in durable order. */
  policyEvents(): readonly Record<string, unknown>[]
  /** Close the session store and release listeners. */
  dispose(): Promise<void>
}

/** The default outcome: a successful call with no structured payload. */
const DEFAULT_OUTCOME: ToolOutcome = { text: 'ok' }

/**
 * Mount the real registry with the 21 real Basic Memory tools.
 *
 * @param options - BMPP configuration and per-tool fixtures.
 */
export async function mountBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const received = new Map<string, Record<string, unknown>[]>()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)

  // The audit domain is the plugin's real durable sink; supplying the facility
  // makes this harness exercise the same storage path production does.
  const audit = auditDomainDouble()
  ctx.provide('storageDomain' as never, audit.facility as never)

  const report = await apply(ctx, options.bmpp ?? { mode: 'enforce', profile: 'compat', policyVersion: '0.1.0' })
  const session = ctx.sessions.create(SessionId('bm-contract'))

  const agent = { session } as unknown as never

  for (const entry of BASIC_MEMORY_CATALOG) {
    registerTool(ctx, entry, options.handlers?.[entry.rawName], received)
  }

  return {
    ctx,
    report,
    session,
    received,
    definition: name => ctx.tools.get(name),
    async call(publicToolName, args = {}) {
      return await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`call-${publicToolName}-${Date.now()}`),
        name: publicToolName,
        arguments: args,
        agent,
      })
    },
    // Read from the audit sidecar, not the session log: BMPP writes no session
    // event, so the session log is where a regression would show up as absence.
    policyEvents: () => audit.records.map(record => record.payload as unknown as Record<string, unknown>),
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}

/**
 * Register one catalogue entry the way the MCP bridge does.
 *
 * The definition carries a permissive JSON-Schema object for parameters and a
 * content-block output contract, mirroring `McpResult`'s text projection. The
 * arguments are NOT validated here on purpose: the bridge passes the model's
 * arguments straight to `tools/call`, and a test that sends malformed arguments
 * must reach the fixture to prove that.
 */
function registerTool(
  ctx: Context,
  entry: CatalogEntry,
  handler: ToolHandler | undefined,
  received: Map<string, Record<string, unknown>[]>,
): void {
  const name = publicName(entry.rawName)
  const tool: ToolDefinition = {
    name,
    description: `Basic Memory ${entry.rawName}`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array' } }, required: ['content'] },
      render: (_args: unknown, value: unknown): ContentBlock[] => {
        const content = (value as { content?: ContentBlock[] }).content ?? []
        return content
      },
    },
    async execute(args: unknown): Promise<unknown> {
      const parsed = (args ?? {}) as Record<string, unknown>
      const log = received.get(entry.rawName) ?? []
      log.push(parsed)
      received.set(entry.rawName, log)

      const outcome = handler === undefined ? DEFAULT_OUTCOME : await handler(parsed)
      // The bridge throws when MCP reports an error, so the registry produces the
      // model-facing isError result — the signal BMPP settles a recall on.
      if (outcome.isError === true) throw new Error(outcome.text)
      return { content: [{ type: 'text', text: outcome.text }] }
    },
  }
  ctx.tools.register(tool)
}

/**
 * Register a plain fixture tool outside the Basic Memory namespace.
 *
 * Used to prove the MVP never governs tools it does not own.
 */
export function registerOutOfScopeTool(ctx: Context, name: string): void {
  ctx.tools.register(defineContentToolFixture({
    name,
    description: `out-of-scope fixture ${name}`,
    parameters: {},
    async execute(): Promise<ContentBlock[]> {
      return [{ type: 'text', text: 'ran' }]
    },
  }))
}
