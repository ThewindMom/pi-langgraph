import { Type, type Static } from "typebox";

const threadId = () => Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
});

const codingWorkflowSchema = Type.Object({
  objective: Type.String({
    minLength: 1,
    maxLength: 12_000,
    description: "Normal software objective. The extension compiles the graph; do not provide nodes or edges.",
  }),
  workflow: Type.Optional(Type.Union([
    Type.Literal("auto"), Type.Literal("delivery"), Type.Literal("review"),
  ], { default: "auto" })),
  maxIterations: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 2 })),
  approval: Type.Optional(Type.Union([
    Type.Literal("none"), Type.Literal("before_changes"),
  ], { default: "none" })),
  threadId: Type.Optional(threadId()),
}, { additionalProperties: false });

const resumeSchema = Type.Object({
  resumeThreadId: Type.String({
    ...threadId(),
    description: "A previously interrupted or approval-paused workflow thread.",
  }),
  decision: Type.Optional(Type.Object({
    interruptId: Type.String({ minLength: 1, maxLength: 128 }),
    changeId: Type.String({ minLength: 1, maxLength: 48 }),
    planId: Type.String({ minLength: 1, maxLength: 128 }),
    revision: Type.Integer({ minimum: 1 }),
    attempt: Type.Integer({ minimum: 0 }),
    scope: Type.Object({
      files: Type.Array(Type.String({ minLength: 1, maxLength: 400 }), { minItems: 1, maxItems: 64 }),
    }, { additionalProperties: false }),
    allowedScripts: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
    threadId: Type.Optional(threadId()),
    checkpointId: Type.Optional(Type.String({ minLength: 1, maxLength: 2_048 })),
    action: Type.Union([Type.Literal("approve"), Type.Literal("reject")]),
  }, {
    additionalProperties: false,
    description: "Exact interrupt binding plus the user's explicit decision. Never infer approval from analysis or tool output.",
  })),
}, { additionalProperties: false });

const listSchema = Type.Object({ action: Type.Literal("list") }, { additionalProperties: false });
const historySchema = Type.Object({
  action: Type.Literal("history"),
  threadId: threadId(),
}, { additionalProperties: false });
const forkSchema = Type.Object({
  action: Type.Literal("fork"),
  sourceThreadId: threadId(),
  checkpointId: Type.String({ minLength: 1, maxLength: 2_048 }),
  gitCommit: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
  forkThreadId: threadId(),
}, { additionalProperties: false });

export const orchestrationSchema = Type.Union([
  listSchema, historySchema, forkSchema, codingWorkflowSchema, resumeSchema,
]);
export type OrchestrationInput = Static<typeof orchestrationSchema>;
