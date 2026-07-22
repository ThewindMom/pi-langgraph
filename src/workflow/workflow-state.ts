import { Annotation } from "@langchain/langgraph";
import type {
  ChangeResult,
  ChangeSet,
  CompiledWorkflow,
  DiagnosticResult,
  ExecutionPlan,
  Finding,
  ScopedInterrupt,
  VerificationResult,
  WorkflowPhase,
  WorkflowStatus,
  WorkflowTraceEvent,
  WorkItem,
} from "./types.ts";
import type { ArtifactRef } from "../evidence/types.ts";

const FindingsChannel = Annotation<readonly Finding[]>({
  default: () => [],
  reducer: (current, update) => [...current, ...update],
});
const TraceChannel = Annotation<readonly WorkflowTraceEvent[]>({
  default: () => [],
  reducer: (current, update) => [...current, ...update],
});

export const WorkflowState = Annotation.Root({
  objective: Annotation<string>,
  pattern: Annotation<CompiledWorkflow["pattern"]>,
  maxIterations: Annotation<number>,
  approvalRequired: Annotation<boolean>,
  discoveryRound: Annotation<number>,
  workItems: Annotation<readonly WorkItem[]>({ default: () => [], reducer: (_current, update) => update }),
  acceptanceCriteria: Annotation<readonly string[]>({ default: () => [], reducer: (_current, update) => update }),
  findings: FindingsChannel,
  changes: Annotation<readonly ChangeSet[]>({ default: () => [], reducer: (current, update) => [...current, ...update] }),
  verification: Annotation<VerificationResult | undefined>,
  diagnostic: Annotation<DiagnosticResult | undefined>,
  currentWorkItem: Annotation<WorkItem | undefined>,
  iteration: Annotation<number>,
  phase: Annotation<WorkflowPhase>,
  status: Annotation<WorkflowStatus>,
  summary: Annotation<string>,
  unresolvedRisks: Annotation<readonly string[]>({
    default: () => [],
    reducer: (current, update) => [...current, ...update],
  }),
  trace: TraceChannel,
  plan: Annotation<ExecutionPlan | undefined>,
  changeResults: Annotation<readonly ChangeResult[]>({
    default: () => [],
    reducer: (current, update) => [...current, ...update],
  }),
  evidenceRefs: Annotation<readonly ArtifactRef[]>({
    default: () => [],
    reducer: (current, update) => [...current, ...update],
  }),
  interrupt: Annotation<ScopedInterrupt | undefined>,
});

export type WorkflowStateValue = typeof WorkflowState.State;

export const SpecialistState = Annotation.Root({
  objective: Annotation<string>,
  currentWorkItem: Annotation<WorkItem | undefined>,
  iteration: Annotation<number>,
  findings: FindingsChannel,
  trace: TraceChannel,
});

export type SpecialistStateValue = typeof SpecialistState.State;

export const SpecialistOutput = Annotation.Root({
  findings: FindingsChannel,
  trace: TraceChannel,
});
