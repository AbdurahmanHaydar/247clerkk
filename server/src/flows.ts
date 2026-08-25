/**
 * The owner-side of the flow builder: read a tenant's intake conversation,
 * save a new one, roll back to an earlier one, and run a draft against made-up
 * messages before it ever touches a real number.
 *
 * Mounted under /admin/:token, so it inherits that guard — see admin.ts.
 */

import type { Hono } from "hono";
import { logEvent, query, queryOne } from "./db.js";
import { runFlow } from "./engine.js";
import { type Flow, defaultFlow, fromLegacyConfig, loadFlow, normalizeFlow, validateFlow } from "./flow.js";

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  vertical: string | null;
  is_demo: boolean;
  wa_display_number: string | null;
  flow: unknown;
  qualification_config: unknown;
};

/** Where the flow a tenant is running actually came from. */
type Source = "flow" | "legacy" | "default";

export function registerFlows(app: Hono): void {
  /** The tenant picker. */
  app.get("/admin/:token/tenants", async (c) => {
    const tenants = await query<TenantRow>(
      `select id, slug, name, vertical, is_demo, wa_display_number, flow, qualification_config
         from tenants order by is_demo desc, name asc`,
    );
    return c.json({
      tenants: tenants.map((tenant) => {
        const flow = loadFlow(tenant.flow, tenant.qualification_config);
        return {
          id: tenant.id,
          slug: tenant.slug,
          name: tenant.name,
          vertical: tenant.vertical,
          isDemo: tenant.is_demo,
          number: tenant.wa_display_number,
          source: sourceOf(tenant),
          flowName: flow.name,
          steps: flow.steps.length,
          questions: flow.steps.filter((step) => step.type === "question").length,
        };
      }),
    });
  });

  app.get("/admin/:token/tenants/:id/flow", async (c) => {
    const tenant = await tenantOf(c.req.param("id"));
    if (!tenant) return c.json({ error: "not_found" }, 404);

    const revisions = await query(
      `select id, note, created_at from flow_revisions where tenant_id = $1
        order by created_at desc limit 30`,
      [tenant.id],
    );

    return c.json({
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, isDemo: tenant.is_demo },
      flow: loadFlow(tenant.flow, tenant.qualification_config),
      source: sourceOf(tenant),
      revisions,
    });
  });

  /**
   * Saves a flow. Refuses anything with an error-level problem: a broken flow
   * here means a live WhatsApp number stops making sense, and the editor has
   * already shown the same list of problems.
   */
  app.put("/admin/:token/tenants/:id/flow", async (c) => {
    const tenant = await tenantOf(c.req.param("id"));
    if (!tenant) return c.json({ error: "not_found" }, 404);

    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "malformed" }, 400);

    const { flow, problems } = validateFlow(body["flow"]);
    const errors = problems.filter((problem) => problem.level === "error");
    if (errors.length > 0) return c.json({ error: "invalid", problems }, 400);

    await save(tenant.id, flow, typeof body["note"] === "string" ? body["note"].slice(0, 200) : null);
    return c.json({ ok: true, flow, problems });
  });

  /** Back to the built-in three questions. */
  app.post("/admin/:token/tenants/:id/flow/reset", async (c) => {
    const tenant = await tenantOf(c.req.param("id"));
    if (!tenant) return c.json({ error: "not_found" }, 404);

    const flow = defaultFlow();
    await save(tenant.id, flow, "reset to default");
    return c.json({ ok: true, flow });
  });

  app.post("/admin/:token/tenants/:id/flow/revisions/:rev/restore", async (c) => {
    const tenant = await tenantOf(c.req.param("id"));
    if (!tenant) return c.json({ error: "not_found" }, 404);

    const revision = Number(c.req.param("rev"));
    if (!Number.isInteger(revision)) return c.json({ error: "not_found" }, 404);

    const row = await queryOne<{ flow: unknown }>(
      `select flow from flow_revisions where id = $1 and tenant_id = $2`,
      [revision, tenant.id],
    );
    if (!row) return c.json({ error: "not_found" }, 404);

    const flow = normalizeFlow(row.flow);
    await save(tenant.id, flow, `restored revision ${revision}`);
    return c.json({ ok: true, flow });
  });

  /**
   * Runs a draft flow against a list of messages, in memory. No tenant, no
   * conversation, no writes — just what the clerk would have said back, and
   * which steps it walked through to get there.
   */
  app.post("/admin/:token/flow/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "malformed" }, 400);

    const flow = normalizeFlow(body["flow"]);
    const messages = (Array.isArray(body["messages"]) ? body["messages"] : [])
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, 25);
    const useModel = body["useModel"] !== false;
    const tenantName = typeof body["tenantName"] === "string" ? body["tenantName"] : "your firm";
    const profileName = typeof body["profileName"] === "string" ? body["profileName"] : null;

    const history: { direction: "in" | "out"; body: string | null }[] = [];
    let state: unknown = {};
    const turns = [];

    for (const message of messages) {
      const result = await runFlow({
        flow,
        state,
        message,
        tenantName,
        profileName,
        history: [...history],
        useModel,
      });
      history.push({ direction: "in", body: message });
      history.push({ direction: "out", body: result.reply });
      state = result.state;
      turns.push({
        in: message,
        out: result.reply,
        trace: result.trace,
        answers: result.answers,
        verdict: result.verdict,
        at: result.state.at,
        done: result.state.done,
        model: result.model,
      });
    }

    return c.json({ turns, state, problems: validateFlow(flow).problems });
  });
}

async function tenantOf(id: string): Promise<TenantRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return queryOne<TenantRow>(
    `select id, slug, name, vertical, is_demo, wa_display_number, flow, qualification_config
       from tenants where id = $1`,
    [id],
  );
}

function sourceOf(tenant: TenantRow): Source {
  const flow = tenant.flow;
  if (flow && typeof flow === "object" && Array.isArray((flow as Record<string, unknown>)["steps"])) {
    if (((flow as Record<string, unknown>)["steps"] as unknown[]).length > 0) return "flow";
  }
  return fromLegacyConfig(tenant.qualification_config) ? "legacy" : "default";
}

/** One save: the new flow on the tenant, and a copy kept for rollback. */
async function save(tenantId: string, flow: Flow, note: string | null): Promise<void> {
  const json = JSON.stringify(flow);
  await query(`update tenants set flow = $1 where id = $2`, [json, tenantId]);
  await query(`insert into flow_revisions (tenant_id, flow, note) values ($1, $2, $3)`, [
    tenantId,
    json,
    note,
  ]);
  await logEvent(tenantId, "flow.saved", null, { steps: flow.steps.length, note });
}
