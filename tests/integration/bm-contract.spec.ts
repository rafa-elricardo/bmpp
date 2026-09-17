/**
 * The real Basic Memory contract, and the real move/archive behaviour.
 *
 * Both halves run against the genuine DSH registry and session store with the 21
 * real tool identities of Basic Memory 0.23.2. The MCP server itself is replaced
 * by local fixtures that return the same *shapes* the server returns, so the
 * contract is exercised without reading or writing a single note.
 *
 * What this file establishes:
 *
 * - the catalogue matches the DSH bridge's naming rule exactly;
 * - BMPP's default classification agrees with the server's own annotations;
 * - only `isError` separates a satisfying recall from a failed one, and no
 *   structured payload exists to separate an empty one;
 * - `move_note` is a mutation that is NOT destructive, and the recall gate
 *   applies to it;
 * - `archive/` is a destination convention, and the only mechanically
 *   observable thing about it is the path in the call's arguments;
 * - the write-tracking gap the previous reconnaissance predicted is real.
 *
 * Anything the tests find that production does not handle is asserted as an
 * observed limitation, not smuggled into a policy.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, MEMORY_NAMESPACE } from '../../src/config.ts'
import { BASIC_MEMORY_CATALOG, DESTRUCTIVE_ENTRIES, PUBLIC_NAMES, READ_ONLY_ENTRIES, publicName } from './basic-memory-catalog.ts'
import { mountBridge, registerOutOfScopeTool, type Bridge } from './basic-memory-bridge.ts'

const SEARCH = publicName('search_notes')
const MOVE = publicName('move_note')
const WRITE = publicName('write_note')
const DELETE = publicName('delete_note')
const EDIT = publicName('edit_note')

/** The gate's judged events, in durable order. */
function decisions(bridge: Bridge): readonly Record<string, unknown>[] {
  return bridge.policyEvents().filter(event => event['kind'] === 'pre-execute')
}

/** The judged event for one tool. */
function decisionFor(bridge: Bridge, name: string): Record<string, unknown> | undefined {
  return decisions(bridge).find(event => String(event['tool']) === name)
}

/** Every audit payload the gate recorded in its own sidecar. */
function auditPayloads(bridge: Bridge): readonly Record<string, unknown>[] {
  return bridge.policyEvents()
}

/** The recall state the gate holds after a call, read from its own audit trail. */
function recallState(bridge: Bridge): string | undefined {
  const recalls = bridge.policyEvents().filter(event => event['kind'] === 'recall')
  const last = recalls.at(-1)
  return last === undefined ? undefined : String(last['recallState'])
}

/** Close a bridge without leaking listeners between tests. */
async function withBridge<T>(options: Parameters<typeof mountBridge>[0], body: (bridge: Bridge) => Promise<T>): Promise<T> {
  const bridge = await mountBridge(options)
  try {
    return await body(bridge)
  } finally {
    await bridge.dispose()
  }
}

describe('the catalogue is the real Basic Memory surface', () => {
  it('has 21 tools, split 15 read-only and 6 state-changing', () => {
    expect(BASIC_MEMORY_CATALOG).toHaveLength(21)
    expect(READ_ONLY_ENTRIES).toHaveLength(15)
    expect(BASIC_MEMORY_CATALOG.length - READ_ONLY_ENTRIES.length).toBe(6)
  })

  it('names every tool with the bridge rule mcp__<server>__<rawName>', () => {
    for (const entry of BASIC_MEMORY_CATALOG) {
      expect(publicName(entry.rawName)).toBe(`${MEMORY_NAMESPACE}${entry.rawName}`)
    }
    expect(new Set(PUBLIC_NAMES).size).toBe(21)
  })

  it('advertises four destructive tools, and move_note is not one of them', () => {
    expect(DESTRUCTIVE_ENTRIES.map(entry => entry.rawName).sort()).toEqual([
      'delete_note', 'delete_project', 'edit_note', 'write_note',
    ])
    const move = BASIC_MEMORY_CATALOG.find(entry => entry.rawName === 'move_note')
    expect(move?.readOnly).toBe(false)
    expect(move?.destructive).toBe(false)
  })

  it('registers all 21 tools on the real registry', async () => {
    await withBridge({}, async (bridge) => {
      for (const name of PUBLIC_NAMES) {
        expect(bridge.definition(name), `${name} was not registered`).toBeDefined()
      }
      expect(bridge.ctx.tools.schemas().length).toBeGreaterThanOrEqual(21)
    })
  })

  it('projects only name, description and parameters onto the model surface', async () => {
    await withBridge({}, async (bridge) => {
      const schema = bridge.ctx.tools.schemas().find(entry => entry.name === SEARCH)
      expect(Object.keys(schema ?? {}).sort()).toEqual(['description', 'name', 'parameters'])
      // The MCP server's own annotations are NOT forwarded to the model surface;
      // an empty parameter projection is all this fixture advertises.
      expect(schema?.parameters).toMatchObject({ type: 'object' })
    })
  })
})

describe('BMPP classification agrees with the server annotations', () => {
  it('contains every read-only tool and every state-changing tool', () => {
    for (const entry of READ_ONLY_ENTRIES) {
      expect(DEFAULT_CONFIG.readTools).toContain(publicName(entry.rawName))
    }
    for (const entry of BASIC_MEMORY_CATALOG.filter(candidate => !candidate.readOnly)) {
      expect(DEFAULT_CONFIG.mutatingTools).toContain(publicName(entry.rawName))
    }
  })

  it('restricts approval to the critical subset of the server destructive hints', () => {
    // The server marks four tools destructive; BMPP asks for approval only on the
    // two whose effect cannot be undone by a later write. The relationship is a
    // deliberate narrowing, not a disagreement — so it is asserted as one.
    const serverDestructive = DESTRUCTIVE_ENTRIES.map(entry => publicName(entry.rawName)).sort()
    expect(serverDestructive).toEqual([
      publicName('delete_note'), publicName('delete_project'),
      publicName('edit_note'), publicName('write_note'),
    ].sort())

    expect([...DEFAULT_CONFIG.destructiveTools].sort()).toEqual([
      publicName('delete_note'), publicName('delete_project'),
    ].sort())
    for (const name of DEFAULT_CONFIG.destructiveTools) {
      expect(serverDestructive).toContain(name)
    }
    expect(DEFAULT_CONFIG.destructiveTools).not.toContain(MOVE)
    expect(DEFAULT_CONFIG.destructiveTools).not.toContain(EDIT)
  })

  it('keeps every classified tool inside the memory namespace', () => {
    for (const name of [...DEFAULT_CONFIG.readTools, ...DEFAULT_CONFIG.mutatingTools, ...DEFAULT_CONFIG.destructiveTools]) {
      expect(name.startsWith(MEMORY_NAMESPACE)).toBe(true)
    }
  })

  it('satisfies recall from search_notes, search and build_context only', () => {
    expect([...DEFAULT_CONFIG.searchTools].sort()).toEqual([
      publicName('build_context'), publicName('search'), publicName('search_notes'),
    ].sort())
    // Activity is a read, but not a subject search.
    expect(DEFAULT_CONFIG.readTools).toContain(publicName('recent_activity'))
    expect(DEFAULT_CONFIG.searchTools).not.toContain(publicName('recent_activity'))
  })

  it('allows every read-only tool on an unclassified turn', async () => {
    await withBridge({}, async (bridge) => {
      for (const entry of READ_ONLY_ENTRIES) {
        const result = await bridge.call(publicName(entry.rawName), { identifier: 'x', url: 'memory://x', path: 'x', id: 'x', query: 'x', note_type: 'x' })
        expect(result.isError, `${entry.rawName} was blocked`).toBe(false)
      }
      // None of these reads produced a write decision.
      for (const event of decisions(bridge)) {
        expect(event['toolClass']).toBe('memory.read')
      }
    })
  })

  it('denies every state-changing tool on an unclassified turn', async () => {
    await withBridge({}, async (bridge) => {
      for (const entry of BASIC_MEMORY_CATALOG.filter(candidate => !candidate.readOnly)) {
        const result = await bridge.call(publicName(entry.rawName), {
          identifier: 'x', title: 'T', content: 'c', directory: 'D',
          operation: 'append', project_name: 'p', project_path: '/tmp/p',
        })
        expect(result.isError, `${entry.rawName} was allowed`).toBe(true)
        const event = decisionFor(bridge, publicName(entry.rawName))
        expect(event?.['reasonCode']).toBe('CLASSIFICATION_REQUIRED')
        expect(event?.['toolClass']).toBe('memory.write')
      }
    })
  })

  it('never governs a tool outside the memory namespace', async () => {
    await withBridge({}, async (bridge) => {
      registerOutOfScopeTool(bridge.ctx, 'bash')
      const result = await bridge.call('bash', { command: 'ls' })
      expect(result.isError).toBe(false)
      expect(decisionFor(bridge, 'bash')?.['reasonCode']).toBe('ALLOW_OUT_OF_SCOPE')
      expect(decisionFor(bridge, 'bash')?.['toolClass']).toBe('other')
    })
  })
})

describe('the recall signal is isError, and nothing else', () => {
  it('returns only content blocks as the canonical value, with no structured payload', async () => {
    await withBridge({}, async (bridge) => {
      const result = await bridge.call(SEARCH, { query: 'example query' })
      expect(result.isError).toBe(false)
      if (result.isError) return
      // `McpResult` with no `structuredContent`: the bridge cannot project one
      // because the server advertises no outputSchema for any of its tools.
      expect(Object.keys(result.value as object)).toEqual(['content'])
      expect((result.value as { structuredContent?: unknown }).structuredContent).toBeUndefined()
    })
  })

  it('settles the recall as ok when the search does not error', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'No results found' }) },
    }, async (bridge) => {
      const result = await bridge.call(SEARCH, { query: 'nothing matches this' })
      expect(result.isError).toBe(false)
      expect(recallState(bridge)).toBe('succeeded')
      const recall = bridge.policyEvents().find(event => event['kind'] === 'recall')
      expect(recall?.['recallOutcome']).toBe('ok')
    })
  })

  it('settles the recall as failed when the search errors', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'memory backend unavailable', isError: true }) },
    }, async (bridge) => {
      const result = await bridge.call(SEARCH, { query: 'example query' })
      expect(result.isError).toBe(true)
      expect(recallState(bridge)).toBe('failed')
      const recall = bridge.policyEvents().find(event => event['kind'] === 'recall')
      expect(recall?.['recallOutcome']).toBe('failed')
    })
  })

  it('cannot distinguish an empty result, and never claims to', async () => {
    // Two searches whose results differ only in TEXT: one says it found notes,
    // the other says it found none. Both settle the recall identically, because
    // the only structural signal available is the error flag.
    const populated = await mountBridge({ handlers: { search_notes: () => ({ text: '3 notes found' }) } })
    const empty = await mountBridge({ handlers: { search_notes: () => ({ text: 'No results found' }) } })
    try {
      await populated.call(SEARCH, { query: 'example query' })
      await empty.call(SEARCH, { query: 'example query' })
      const populatedRecall = populated.policyEvents().find(event => event['kind'] === 'recall')
      const emptyRecall = empty.policyEvents().find(event => event['kind'] === 'recall')
      expect(populatedRecall?.['recallOutcome']).toBe('ok')
      expect(emptyRecall?.['recallOutcome']).toBe('ok')
      expect(emptyRecall?.['recallOutcome']).not.toBe('empty')
      // The audit payload carries no note content, so nothing about the result
      // body could be used to guess either.
      const serialized = JSON.stringify(emptyRecall)
      expect(serialized).not.toContain('No results found')
      expect(serialized).not.toContain('example query')
    } finally {
      await populated.dispose()
      await empty.dispose()
    }
  })

  it('never lets a rival search read settle the recall without a result', async () => {
    await withBridge({}, async (bridge) => {
      // A read that is not a search tool does not open a recall at all.
      const result = await bridge.call(publicName('read_note'), { identifier: 'note' })
      expect(result.isError).toBe(false)
      expect(recallState(bridge)).toBeUndefined()
      expect(decisionFor(bridge, publicName('read_note'))?.['reasonCode']).toBe('ALLOW_READ_ONLY')
    })
  })

  it('decides malformed arguments instead of throwing', async () => {
    const hostile = [undefined, null, 'string', 42, [], { query: 7 }]
    await withBridge({}, async (bridge) => {
      const outcomes: boolean[] = []
      for (const args of hostile) {
        const result = await bridge.call(SEARCH, args as Record<string, unknown>)
        outcomes.push(result.isError)
      }
      // None threw out of the pipeline and none was an error: a read is allowed
      // whatever the arguments look like.
      expect(outcomes.every(isError => isError === false)).toBe(true)
      const judged = decisions(bridge).filter(event => event['tool'] === SEARCH)
      expect(judged.length).toBeGreaterThanOrEqual(hostile.length - 1)
      expect(judged.every(event => event['reasonCode'] === 'ALLOW_READ_ONLY')).toBe(true)
    })
  })
})

describe('move_note: the real contract', () => {
  it('requires an identifier and accepts a destination path or folder', async () => {
    const move = BASIC_MEMORY_CATALOG.find(entry => entry.rawName === 'move_note')
    expect(move?.required).toEqual(['identifier'])
    // A move is a mutation, so the turn must be COMPLEX and a lookup must have
    // succeeded before the fixture is ever reached.
    await withBridge({
      handlers: { search_notes: () => ({ text: 'No results found' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      await bridge.call(MOVE, { identifier: 'Note', destination_folder: 'archive' })
      const calls = bridge.received.get('move_note') ?? []
      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ identifier: 'Note', destination_path: 'archive/Note.md' })
      expect(calls[1]).toMatchObject({ identifier: 'Note', destination_folder: 'archive' })
    })
  })

  it('reports moved, title, permalink, file_path, source and destination', async () => {
    // The success shape the server returns with `output_format: "json"`. The
    // permalink is reported unchanged, which is the documented behaviour while
    // `update_permalinks_on_move` is false.
    const payload = {
      moved: true, title: 'Note', permalink: 'main/projects/note',
      file_path: 'archive/Note.md', source: 'Note', destination: 'archive/Note.md',
    }
    await withBridge({
      handlers: {
        search_notes: () => ({ text: 'No results found' }),
        move_note: () => ({ text: JSON.stringify(payload) }),
      },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      const result = await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      expect(result.isError).toBe(false)
      if (result.isError) return
      const text = (result.value as { content: { text: string }[] }).content[0]?.text ?? ''
      expect(JSON.parse(text)).toMatchObject({ moved: true, permalink: 'main/projects/note' })
    })
  })

  it('is a mutation: an unclassified turn refuses it', async () => {
    await withBridge({}, async (bridge) => {
      const result = await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      expect(result.isError).toBe(true)
      const event = decisionFor(bridge, MOVE)
      expect(event?.['toolClass']).toBe('memory.write')
      expect(event?.['reasonCode']).toBe('CLASSIFICATION_REQUIRED')
    })
  })

  it('is not destructive: enforce + strict does not request approval for it', async () => {
    await withBridge({ bmpp: { mode: 'enforce', profile: 'strict' } }, async (bridge) => {
      const moved = await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      expect(moved.isError).toBe(true)
      // No approval seam is composed, so an `ask` would have failed closed. The
      // event shows a plain denial instead, which is what "not destructive" means.
      const moveEvent = decisionFor(bridge, MOVE)
      expect(moveEvent?.['enforcement']).toBe('denied')

      const deleted = await bridge.call(DELETE, { identifier: 'Note' })
      expect(deleted.isError).toBe(true)
      const deleteEvent = decisionFor(bridge, DELETE)
      // `delete_note` IS destructive, so under `strict` the enforcement is an
      // approval request that fails closed with no approval service.
      expect(deleteEvent?.['enforcement']).toBe('asked')
    })
  })

  it('is released once the turn is COMPLEX and a search succeeded', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'No results found' }) },
    }, async (bridge) => {
      // Classify the turn by driving the control tool the plugin registers.
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      const moved = await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      expect(moved.isError).toBe(false)
      expect(decisionFor(bridge, MOVE)?.['reasonCode']).toBe('ALLOW_RECALL_OK')
    })
  })
})

describe('archive is a destination convention, not a mechanism', () => {
  it('has no dedicated tool for archiving', () => {
    const archival = BASIC_MEMORY_CATALOG.filter(entry => /archiv|supersed|retire/i.test(entry.rawName))
    expect(archival).toEqual([])
  })

  it('records an archive destination as an ordinary move in the audit trail', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'No results found' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Old Note', destination_path: 'archive/Old Note.md' })

      const event = decisionFor(bridge, MOVE)
      // Nothing distinguishes this from any other move: the gate knows the tool
      // and the verdict, not the semantic status of the note.
      expect(event?.['reasonCode']).toBe('ALLOW_RECALL_OK')
      expect(event?.['policyState']).toBe('RECALL_OK')
      // The destination is visible only because the caller sent it.
      const calls = bridge.received.get('move_note') ?? []
      expect(String(calls.at(-1)?.['destination_path'])).toContain('archive/')
    })
  })

  it('keeps the destination out of the durable audit payload', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Old Note', destination_path: 'archive/Old Note.md' })

      const serialized = JSON.stringify(auditPayloads(bridge))
      expect(serialized).not.toContain('archive/')
      expect(serialized).not.toContain('Old Note')
      expect(serialized).not.toContain('destination_path')
    })
  })

  it('does not treat a destination path as satisfying the recall precondition', async () => {
    await withBridge({}, async (bridge) => {
      // COMPLEX without any search, then a move straight to archive: the move is
      // still refused, so a path cannot stand in for a lookup.
      await bridge.call('bmpp__classify', { task: 'complex' })
      const moved = await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      expect(moved.isError).toBe(true)
      expect(decisionFor(bridge, MOVE)?.['reasonCode']).toBe('MEMORY_LOOKUP_REQUIRED')
    })
  })
})

describe('the write tracker sees a move destination', () => {
  it('distinguishes two moves of one note to different destinations', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Note A', destination_path: 'archive/A.md' })
      await bridge.call(MOVE, { identifier: 'Note A', destination_path: 'archive/B.md' })

      // Both moves really ran and both were permitted.
      const calls = bridge.received.get('move_note') ?? []
      expect(calls.map(call => call['destination_path'])).toEqual(['archive/A.md', 'archive/B.md'])
      expect(calls[0]?.['identifier']).toBe(calls[1]?.['identifier'])

      // The identity now carries the destination, so the two operations are two:
      // the tracker can tell them apart without reading a single note.
      const state = bridge.report.gate?.stateOf(String(bridge.session.id))
      const keys = Object.keys(state?.turn.writes ?? {})
      expect(keys).toHaveLength(2)
      expect(keys.some(key => key.includes('path:archive/A.md'))).toBe(true)
      expect(keys.some(key => key.includes('path:archive/B.md'))).toBe(true)

      // The audit trail still reports the same tool and class — the destination
      // is the GUARD's business, not the audit payload's.
      const moveEvents = decisions(bridge).filter(event => event['tool'] === MOVE)
      expect(moveEvents).toHaveLength(2)
      expect(moveEvents[0]?.['toolClass']).toBe('memory.write')
      for (const payload of auditPayloads(bridge)) {
        expect(Object.keys(payload)).not.toContain('destination_path')
        expect(Object.keys(payload)).not.toContain('destination')
      }
    })
  })

  it('treats a repeated identical move as the same operation', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })

      const state = bridge.report.gate?.stateOf(String(bridge.session.id))
      const writes = state?.turn.writes ?? {}
      expect(Object.keys(writes)).toHaveLength(1)
      expect(Object.values(writes)).toEqual([2])
    })
  })

  it('keeps destination_folder distinct from destination_path', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive' })
      await bridge.call(MOVE, { identifier: 'Note', destination_folder: 'archive' })

      const state = bridge.report.gate?.stateOf(String(bridge.session.id))
      const keys = Object.keys(state?.turn.writes ?? {})
      expect(keys).toHaveLength(2)
      expect(keys.some(key => key.includes('path:archive'))).toBe(true)
      expect(keys.some(key => key.includes('folder:archive'))).toBe(true)
    })
  })

  it('never records note content in the write identity', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      const secret = 'note body that must never reach the tracker'
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(WRITE, { title: 'T', content: secret, directory: 'D', file_path: 'Notes/T.md' })
      await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })

      const state = bridge.report.gate?.stateOf(String(bridge.session.id))
      const serialized = JSON.stringify(state?.turn.writes ?? {})
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('note body')
      // The identity is tool + origin + destination, and nothing else.
      for (const key of Object.keys(state?.turn.writes ?? {})) {
        expect(key.split('\u0000')).toHaveLength(3)
      }
    })
  })

  it('leaves overwrite tracking unaffected for write_note, which does carry a path', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      // `write_note` with `overwrite` and no prior read of that note is refused,
      // which proves the tracker DOES see `file_path` when the tool supplies it.
      const denied = await bridge.call(WRITE, {
        title: 'T', content: 'c', directory: 'D', file_path: 'Notes/T.md', overwrite: true,
      })
      expect(denied.isError).toBe(true)
      expect(decisionFor(bridge, WRITE)?.['reasonCode']).toBe('OVERWRITE_REQUIRES_READ')

      // An ordinary create is allowed once the recall is satisfied.
      const created = await bridge.call(WRITE, { title: 'T2', content: 'c', directory: 'D' })
      expect(created.isError).toBe(false)
    })
  })

  it('does not confuse a move with an edit', async () => {
    await withBridge({
      handlers: { search_notes: () => ({ text: 'ok' }) },
    }, async (bridge) => {
      await bridge.call('bmpp__classify', { task: 'complex' })
      await bridge.call(SEARCH, { query: 'note' })
      await bridge.call(MOVE, { identifier: 'Note', destination_path: 'archive/Note.md' })
      await bridge.call(EDIT, { identifier: 'Note', operation: 'append', content: 'x' })
      const classes = decisions(bridge)
        .filter(event => event['tool'] === MOVE || event['tool'] === EDIT)
        .map(event => event['toolClass'])
      expect(classes).toEqual(['memory.write', 'memory.write'])
      // The server marks `edit_note` destructive but NOT `move_note`; BMPP's
      // approval set is narrower still and contains neither.
      const serverDestructive = DESTRUCTIVE_ENTRIES.map(entry => publicName(entry.rawName))
      expect(serverDestructive).toContain(EDIT)
      expect(serverDestructive).not.toContain(MOVE)
      expect(DEFAULT_CONFIG.destructiveTools).not.toContain(EDIT)
      expect(DEFAULT_CONFIG.destructiveTools).not.toContain(MOVE)
    })
  })
})
