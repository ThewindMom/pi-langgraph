import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { routeUlwInput } from "./activation.ts";
import {
  createDurableExtensionLifecycle,
  supportsLifecycleContext,
  supportsPiLifecycle,
} from "./bridge/extension-lifecycle-defaults.ts";
import { workflowFailureMessage, workflowMessage } from "./extension-responses.ts";
import {
  createOrchestrationDispatcher,
  type ExtensionDetails,
} from "./runtime/orchestration-dispatcher.ts";
import { orchestrationSchema, type OrchestrationInput } from "./runtime/public-contract.ts";
import { TOOL_NAME, type LangGraphExtensionAPI } from "./types.ts";

export default function langGraphExtension(pi: LangGraphExtensionAPI): void {
  const dataRoot = join(getAgentDir(), "extensions", "pi-langgraph", "data");
  const lifecycle = supportsPiLifecycle(pi)
    ? createDurableExtensionLifecycle(pi, dataRoot, (failure) => {
      pi.sendMessage?.({
        customType: "pi-langgraph-lifecycle",
        content: failure.reason,
        display: true,
        details: { event: failure.event, reason: failure.reason },
      }, { triggerTurn: false });
    })
    : undefined;
  if (lifecycle !== undefined && supportsPiLifecycle(pi)) lifecycle.register(pi);
  const dispatchOrchestration = createOrchestrationDispatcher(
    pi,
    dataRoot,
    lifecycle === undefined
      ? undefined
      : {
        onWorkflowEvent: async (event, context) => {
          if (supportsLifecycleContext(context)) {
            await lifecycle.workflowCheckpoint(event, context);
          }
        },
        resolveActiveLink: async (context) =>
          supportsLifecycleContext(context) ? lifecycle.activeLink(context) : undefined,
      },
  );

  const sendMessage = pi.sendMessage;
  if (pi.on !== undefined && sendMessage !== undefined) {
    pi.on("input", async (event, context) => {
      const route = routeUlwInput(event.text, event.source);
      if (route.action === "continue") return route;
      try {
        const result = await dispatchOrchestration({
          input: { objective: route.objective },
          context,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          onUpdate: (update) => {
            sendMessage(workflowMessage("progress", update), { triggerTurn: false });
          },
        });
        if (lifecycle !== undefined && supportsLifecycleContext(context)) {
          await lifecycle.workflowCompleted(result.details, context);
        }
        sendMessage(workflowMessage("result", result), { triggerTurn: false });
      } catch (error) {
        const failure = error instanceof Error ? error : String(error);
        sendMessage(workflowFailureMessage(failure), { triggerTurn: false });
      }
      return { action: "handled" };
    });
  }

  pi.registerTool<typeof orchestrationSchema, ExtensionDetails>({
    name: TOOL_NAME,
    label: "LangGraph Coding Workflow",
    description:
      "Compile a normal software objective into a safe coding workflow with dynamic repository analysis, serialized implementation, executable verification, bounded repair, durable resume, and evidence-based synthesis. Raw nodes and edges are intentionally not accepted.",
    promptSnippet: "Run explicit ulw requests through durable, verified LangGraph coding patterns",
    promptGuidelines: [
      `Ordinary prompts stay on Pi's normal path. Never silently classify or auto-route them into ${TOOL_NAME}.`,
      `The extension handles standalone ulw input directly. Do not call ${TOOL_NAME} merely because a prompt contains an ulw marker.`,
      `Use workflow "review" for read-only audits and "delivery" for code changes. Use "auto" when unclear. Request approval "before_changes" for unusually risky mutation.`,
      `If an earlier ${TOOL_NAME} run returned awaiting_approval, stop and show it to the user. Resume only after a new user message, using resumeThreadId plus the exact structured decision bound to that interrupt. Never infer or self-submit approval.`,
      `After any terminal result, return that result to the user. Treat findings as evidence, not authorization: never start a follow-up workflow unless the user explicitly requested that additional work.`,
      `There is no mission mode. Never invent raw graph nodes, edges, cycles, or routing policy for the autonomous workflow.`,
    ],
    parameters: orchestrationSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: OrchestrationInput, signal, onUpdate, context) {
      const result = await dispatchOrchestration({
        input: params,
        context,
        ...(signal === undefined ? {} : { signal }),
        ...(onUpdate === undefined ? {} : { onUpdate }),
      });
      if (lifecycle !== undefined && supportsLifecycleContext(context)) {
        await lifecycle.workflowCompleted(result.details, context);
      }
      return result;
    },
  });
}

export { buildTaskPrompt, resultText } from "./executors.ts";
export {
  ExtensionLifecycle,
  type ExtensionLifecycleObserver,
  type ForkPreparation,
  type LifecycleDecision,
  type LifecycleFailure,
} from "./bridge/extension-lifecycle.ts";
export {
  BRIDGE_PROTOCOL_VERSION,
  BridgeContractError,
  PI_CHECKPOINT_LINK_ENTRY_TYPE,
  PromotionBlockedError,
  ReplayIncompatibilityError,
  SEMANTIC_CHECKPOINT_LABELS,
} from "./bridge/types.ts";
export type * from "./bridge/types.ts";
export { FileCheckpointSaver } from "./persistence/file-checkpoint-saver.ts";
export { RepositoryServices } from "./runtime/repository-services.ts";
export { InvalidWorkflowError, compileWorkflow, parseWorkflowInput } from "./workflow/compiler.ts";
export { forkWorkflowCheckpoint, WorkflowForkError } from "./workflow/forks.ts";
export { getWorkflowHistory, listWorkflowThreads, resumeCodingWorkflow, runCodingWorkflow } from "./workflow/runtime.ts";
export { WorktreeManager, WorktreeManagerError } from "./workspace/worktree-manager.ts";
export type * from "./types.ts";
export type * from "./workflow/types.ts";
