/**
 * Partner-runtime emitters (gap 11).
 *
 * The review's finding: "interoperable with all agentic frameworks" collapsed
 * to "we ship MCP" in all three designs, missing the direction that actually
 * matters commercially — being callable INSIDE Agentforce, Breeze and monday's
 * agent runtimes rather than only syncing records outward.
 *
 * Because every capability is a registry entry with schemas, scopes and
 * annotations, each partner is an emitter over that registry. This whole file
 * is the closure: adding a partner is a function, not a project.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { listOperations, type AnyOperation } from "@backline/domain";

export interface EmitterOutput {
  readonly filename: string;
  readonly contentType: string;
  /**
   * "partner" outputs are consumed by a third-party runtime that can actually
   * invoke us, and therefore must never carry a MONEY or EGRESS operation —
   * our approval UX does not exist over there. "first_party" outputs are
   * metadata for our own front end, where the approval modal does exist.
   * `scripts/verify-operation-registry.ts` enforces the distinction.
   */
  readonly surface: "partner" | "first_party";
  readonly body: unknown;
}

const jsonSchema = (operation: AnyOperation): unknown =>
  zodToJsonSchema(operation.input, { target: "jsonSchema7" });

/** Operations safe to expose to a third-party runtime: never MONEY or EGRESS. */
function partnerSafeOperations(): AnyOperation[] {
  return listOperations().filter(
    (operation) => !operation.scopes.includes("MONEY") && !operation.scopes.includes("EGRESS"),
  );
}

/**
 * Salesforce Agentforce consumes OpenAPI 3.0 to generate invocable actions via
 * External Services, so the emitter is an OpenAPI subset plus the Named
 * Credential descriptor.
 */
export function emitAgentforce(baseUrl: string): EmitterOutput {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of partnerSafeOperations()) {
    const path = operation.rest.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    paths[path] ??= {};
    paths[path][operation.rest.method.toLowerCase()] = {
      operationId: operation.id,
      summary: operation.summary,
      description: operation.description,
      requestBody: {
        required: true,
        content: { "application/json": { schema: jsonSchema(operation) } },
      },
      responses: { "200": { description: "Success" } },
    };
  }
  return {
    filename: "agentforce/backline-external-service.json",
    contentType: "application/json",
    surface: "partner",
    body: {
      openapi: "3.0.3",
      info: { title: "Backline CRM", version: "0.1.0" },
      servers: [{ url: baseUrl }],
      "x-sfdc": {
        namedCredential: "Backline",
        authentication: { type: "Bearer", tokenPrefix: "blk_" },
      },
      paths,
    },
  };
}

/** HubSpot Breeze custom actions: manifest plus the input schema per action. */
export function emitBreeze(baseUrl: string): EmitterOutput {
  return {
    filename: "breeze/backline-actions.json",
    contentType: "application/json",
    surface: "partner",
    body: {
      name: "Backline",
      description: "Music booking CRM operations",
      auth: { type: "bearer", tokenPrefix: "blk_" },
      actions: partnerSafeOperations().map((operation) => ({
        actionId: operation.id,
        label: operation.summary,
        description: operation.description,
        endpoint: { method: operation.rest.method, url: `${baseUrl}${operation.rest.path}` },
        inputFields: jsonSchema(operation),
        isReadOnly: operation.annotations.readOnlyHint,
      })),
    },
  };
}

/** monday.com app manifest exposing operations as AI-block actions. */
export function emitMondayApp(baseUrl: string): EmitterOutput {
  return {
    filename: "monday/backline-app-manifest.json",
    contentType: "application/json",
    surface: "partner",
    body: {
      app: { name: "Backline", version: "0.1.0" },
      features: [
        {
          type: "ai_block",
          name: "Backline CRM",
          actions: partnerSafeOperations().map((operation) => ({
            id: operation.id,
            name: operation.summary,
            description: operation.description,
            url: `${baseUrl}${operation.rest.path}`,
            method: operation.rest.method,
            inputSchema: jsonSchema(operation),
          })),
        },
      ],
    },
  };
}

/** OpenAI Responses-format tool definitions. */
export function emitOpenAiTools(): EmitterOutput {
  return {
    filename: "openai/backline-tools.json",
    contentType: "application/json",
    surface: "partner",
    body: partnerSafeOperations().map((operation) => ({
      type: "function",
      name: operation.id,
      description: operation.description,
      parameters: jsonSchema(operation),
      strict: false,
    })),
  };
}

/** LangChain / LlamaIndex structured-tool descriptors. */
export function emitLangChainTools(baseUrl: string): EmitterOutput {
  return {
    filename: "langchain/backline_tools.json",
    contentType: "application/json",
    surface: "partner",
    body: partnerSafeOperations().map((operation) => ({
      name: operation.id,
      description: operation.description,
      args_schema: jsonSchema(operation),
      endpoint: `${baseUrl}${operation.rest.path}`,
      method: operation.rest.method,
      return_direct: false,
    })),
  };
}

/**
 * AG-UI backend-event to render-hint mapping.
 *
 * The agoragentic ag-ui adapter's table, applied to CRM operations: an
 * approval becomes a modal, a long job becomes an inline progress card. Keeps
 * the UI decoupled from any one agent framework.
 */
export function emitAgUiHints(): EmitterOutput {
  return {
    filename: "ag-ui/backline-render-hints.json",
    contentType: "application/json",
    surface: "first_party",
    body: listOperations().map((operation) => ({
      operationId: operation.id,
      onStart: operation.longRunning ? "inline_progress" : "inline",
      onApprovalRequired: "modal",
      onSuccess: operation.annotations.readOnlyHint ? "result_card" : "artifact_card",
      onError: "error_boundary",
    })),
  };
}

/**
 * Zapier / Make inbound webhooks — how small agencies actually integrate, and
 * unmentioned by all three reviewed designs.
 */
export function emitZapierActions(baseUrl: string): EmitterOutput {
  return {
    filename: "zapier/backline-actions.json",
    contentType: "application/json",
    surface: "partner",
    body: {
      version: "0.1.0",
      authentication: { type: "custom", fields: [{ key: "apiKey", required: true }] },
      creates: partnerSafeOperations()
        .filter((operation) => !operation.annotations.readOnlyHint)
        .map((operation) => ({
          key: operation.id,
          noun: operation.rest.path.split("/")[2] ?? "record",
          display: { label: operation.summary, description: operation.description },
          operation: {
            inputFields: jsonSchema(operation),
            // One generic hook endpoint maps a flat body onto the operation.
            url: `${baseUrl}/v1/hooks/${operation.id}`,
          },
        })),
      searches: partnerSafeOperations()
        .filter((operation) => operation.annotations.readOnlyHint)
        .map((operation) => ({
          key: operation.id,
          display: { label: operation.summary, description: operation.description },
        })),
    },
  };
}

export function emitAll(baseUrl: string): EmitterOutput[] {
  return [
    emitAgentforce(baseUrl),
    emitBreeze(baseUrl),
    emitMondayApp(baseUrl),
    emitOpenAiTools(),
    emitLangChainTools(baseUrl),
    emitAgUiHints(),
    emitZapierActions(baseUrl),
  ];
}
