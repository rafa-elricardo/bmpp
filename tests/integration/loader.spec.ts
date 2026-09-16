/**
 * Integration proof that BMPP loads inside the real Harness runtime.
 *
 * These tests mount the genuine `@deepseek-ai/dsh-tools` `ToolRuntime` service
 * — the exact package version the envelope names — and then load BMPP through
 * it. A change to the tool-registry surface, or to how the loader hands a
 * plugin its injected service, fails here rather than in production.
 *
 * No profile, no `cordis.patch.yml` and no running Harness are involved: the
 * point is to exercise the runtime contract, not a machine's configuration.
 */

import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { apply, checkToolServiceSurface, REQUIRED_TOOL_SERVICE_METHODS } from '../../src/index.ts'
import { classifyHarnessVersion, detectHarnessVersion } from '../../src/version.ts'

/**
 * Mount the genuine tool registry and report both the context and the service.
 *
 * `ToolRuntime` declares `static inject = ['systemPrompt']`, so it only
 * activates — and therefore only registers itself as the `tools` service —
 * once `SystemPrompt` is mounted. Mounting the registry alone leaves the
 * service absent, which is exactly the kind of ordering bug this test exists to
 * make visible rather than mysterious.
 */
async function mountTools(): Promise<{ ctx: Context; tools: unknown }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return { ctx, tools: ctx.get('tools') }
}

describe('the real ToolRuntime satisfies the surface BMPP probes for', () => {
  it('exposes every required member, so the structural probe passes', async () => {
    const { tools } = await mountTools()
    expect(checkToolServiceSurface(tools)).toEqual([])
  })

  it('is an object with all members as functions, not a partial service', async () => {
    const { tools } = await mountTools()
    for (const member of REQUIRED_TOOL_SERVICE_METHODS) {
      expect(typeof (tools as Record<string, unknown>)[member]).toBe('function')
    }
  })
})

describe('BMPP loads against the real registry through Cordis', () => {
  it('mounts through the Cordis plugin system without throwing', async () => {
    const { ctx } = await mountTools()
    // `ctx.plugin()` returns a fiber, not the plugin's return value, so the
    // load is asserted by its effect: it must activate the injected service and
    // settle without refusing.
    await expect(ctx.plugin({ name: 'bmpp', inject: ['tools'], apply })).resolves.toBeDefined()
    expect(checkToolServiceSurface(ctx.get('tools'))).toEqual([])
    await ctx.fiber.dispose()
  })

  it('reports the verified Harness verdict when the load actually runs', async () => {
    const { ctx } = await mountTools()
    const report = apply(ctx, {})
    expect(report.bmppVersion).toBe('0.1.0')
    expect(report.mode).toBe('audit')
    expect(report.profile).toBe('compat')
    // Detection resolves the real installed package, so the verdict is the
    // load-time compatibility claim being exercised against a real version.
    expect(report.harness).toEqual({
      status: 'compatible',
      version: '0.1.5-rc.2',
      verified: true,
    })
    await ctx.fiber.dispose()
  })

  it('stops cleanly, because it registers nothing yet', async () => {
    const { ctx } = await mountTools()
    await ctx.plugin({ name: 'bmpp', inject: ['tools'], apply })
    // Stopping is idempotent. This guard keeps the contract honest once later
    // phases start registering listeners and tools.
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('refuses to load when the injected service is not the real registry shape', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    // No ToolRuntime mounted: the service is absent, so the probe must refuse.
    expect(() => apply(ctx, {})).toThrow(/missing register, get, guard, schemas, executionMode/)
    await ctx.fiber.dispose()
  })
})

describe('the installed Harness version is the one the envelope claims', () => {
  it('detects the version the project declares as verified', () => {
    const detected = detectHarnessVersion()
    expect(detected).toBe('0.1.5-rc.2')
    const verdict = classifyHarnessVersion(detected)
    expect(verdict.status).toBe('compatible')
  })
})
