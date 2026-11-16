import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { WorldEvent } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const WORLD_EVENT_SCHEMA = {
  type: "object",
  required: [
    "envelope_version",
    "msg_id",
    "kind",
    "msg_type",
    "timestamp",
    "source_node",
    "target_node",
    "payload",
  ],
  properties: {
    envelope_version: { type: "string", const: "1.0" },
    msg_id: { type: "string", minLength: 4 },
    kind: { type: "string", enum: ["OBSERVATION", "ACTION", "HEARTBEAT"] },
    msg_type: { type: "string", minLength: 2 },
    timestamp: { type: "string" },
    source_node: { type: "string", minLength: 2 },
    target_node: { type: "string", minLength: 2 },
    order_id: { type: ["string", "null"] },
    correlation_id: { type: ["string", "null"] },
    outbound: { type: "boolean" },
    ephemeral: { type: "boolean" },
    wake_brain: { type: "boolean" },
    payload: { type: "object" },
  },
  additionalProperties: true,
};

const validateEventFn: ValidateFunction = ajv.compile(WORLD_EVENT_SCHEMA);

export function assertValidWorldEvent(raw: unknown): asserts raw is WorldEvent {
  if (!validateEventFn(raw)) {
    throw new Error(`事件信封格式非法: ${ajv.errorsText(validateEventFn.errors)}`);
  }
}

export function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  return ajv.compile(schema);
}
