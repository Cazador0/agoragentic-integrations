/**
 * REST head.
 *
 * Routes are PROJECTED from the operation registry, not hand-written. Adding an
 * operation adds its route, its OpenAPI path, its MCP tool and its A2A skill at
 * once, and `scripts/verify-operation-registry.ts` fails the build if any
 * surface drifts from the registry.
 */

import { Hono } from "hono";
import {
  ErrorCode,
  ServiceError,
  listOperations,
  type AnyOperation,
} from "@backline/domain";
import type { RunContext } from "@backline/services";

export type OperationHandler = (ctx: RunContext, input: unknown) => Promise<unknown>;
export type HandlerMap = Readonly<Record<string, OperationHandler>>;
export type ContextResolver = (headers: Headers, tenantHint?: string) => Promise<RunContext>;

/** Hono path params come as strings; the zod schema owns real coercion. */
function mergeInput(params: Record<string, string>, query: URLSearchParams, body: unknown): unknown {
  const merged: Record<string, unknown> = { ...params };
  for (const [key, value] of query.entries()) merged[key] = value;
  if (body && typeof body === "object") Object.assign(merged, body);
  return merged;
}

export function createApi(handlers: HandlerMap, resolveContext: ContextResolver): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Discovery surfaces, so an agent can self-onboard without a human.
  app.get("/.well-known/openapi.json", (c) => c.json(buildOpenApi()));
  app.get("/.well-known/agent-card.json", (c) => c.json(buildAgentCard()));

  for (const operation of listOperations()) {
    const handler = handlers[operation.id];
    if (!handler) continue; // Declared but not yet implemented; verify script reports it.

    app.on(operation.rest.method, operation.rest.path, async (c) => {
      try {
        const ctx = await resolveContext(c.req.raw.headers, c.req.header("x-backline-tenant"));
        const body = operation.rest.method === "GET" ? undefined : await c.req.json().catch(() => ({}));
        const raw = mergeInput(c.req.param(), new URL(c.req.url).searchParams, body);
        const input = operation.input.parse(raw);
        const result = await handler(ctx, input);

        // Quota surfaced as data so agents self-throttle rather than discovering
        // limits by being rejected (the Sforce-Limit-Info pattern).
        c.header("X-Backline-Usage", "operations=1");
        return c.json(result);
      } catch (error) {
        if (error instanceof ServiceError) {
          return c.json(error.toPayload(), error.httpStatus as 400);
        }
        const payload = new ServiceError(
          ErrorCode.VALIDATION,
          error instanceof Error ? error.message : "Invalid request",
        ).toPayload();
        return c.json(payload, 400);
      }
    });
  }

  return app;
}

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of listOperations()) {
    const path = operation.rest.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    paths[path] ??= {};
    paths[path][operation.rest.method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.summary,
      description: operation.description,
      "x-backline-scopes": operation.scopes,
      "x-backline-confirm-required": operation.confirmRequired ?? false,
      responses: { "200": { description: "Success" } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Backline CRM", version: "0.1.0" },
    paths,
  };
}

export function buildAgentCard(): Record<string, unknown> {
  return {
    name: "Backline",
    description: "Agentic CRM for music management and booking agencies.",
    version: "0.1.0",
    authentication: { schemes: ["bearer"], credentialPrefix: "blk_" },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    skills: listOperations()
      .filter((operation): operation is AnyOperation & { a2aSkill: string } => Boolean(operation.a2aSkill))
      .map((operation) => ({
        id: operation.a2aSkill,
        name: operation.summary,
        description: operation.description,
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      })),
  };
}
