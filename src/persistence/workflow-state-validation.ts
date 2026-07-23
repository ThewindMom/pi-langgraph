import { boolean, integer, invalid, items, optional, record, strings, text } from "./workflow-validation-primitives.ts";
import {
  validateArtifactRef, validateChange, validateChangeResult, validateDiagnostic, validateExecutionPlan,
  validateFinding, validateInterrupt, validateTrace, validateVerification, validateWorkItem,
} from "./workflow-state-field-validation.ts";

const PHASES = new Set(["classified", "discovered", "analyzed", "implemented", "verified", "diagnosed", "repaired", "synthesized", "escalated"]);
const STATUSES = new Set(["running", "awaiting_approval", "completed", "needs_attention"]);
export const SEMANTIC_CHECKPOINT_LABELS = ["post-discovery", "pre-mutation", "last-known-green", "post-repair"] as const;
export type SemanticCheckpointLabel = typeof SEMANTIC_CHECKPOINT_LABELS[number];
const WORKFLOW_CHANNELS = ["objective", "pattern", "maxIterations", "approvalRequired", "discoveryRound", "workItems", "acceptanceCriteria", "findings", "changes", "verification", "diagnostic", "currentWorkItem", "iteration", "phase", "status", "summary", "unresolvedRisks", "trace", "plan", "changeResults", "evidenceRefs", "interrupt"] as const;
const OPTIONAL_WORKFLOW_CHANNELS = new Set(["verification", "diagnostic", "currentWorkItem", "plan", "changeResults", "evidenceRefs", "interrupt"]);
const REQUIRED_WORKFLOW_CHANNELS = WORKFLOW_CHANNELS.filter((channel) => !OPTIONAL_WORKFLOW_CHANNELS.has(channel));
function hasOwn(value: Readonly<Record<string, unknown>>, field: string): boolean { return Object.prototype.hasOwnProperty.call(value, field); }

export function validatePersistedWorkflowChannels(value: unknown): void {
  const state = record(value, "checkpoint channel_values");
  if (!WORKFLOW_CHANNELS.some((channel) => hasOwn(state, channel))) return;
  if (!hasOwn(state, "objective") && hasOwn(state, "__start__")) { validateBootstrapChannels(state); return; }
  for (const channel of REQUIRED_WORKFLOW_CHANNELS) if (!hasOwn(state, channel)) invalid(`missing ${channel}`);
  text(state.objective, "objective", 12_000);
  if (state.pattern !== "delivery" && state.pattern !== "review") invalid("pattern");
  const pattern = state.pattern;
  const maxIterations = integer(state.maxIterations, "maxIterations", 0, 5);
  boolean(state.approvalRequired, "approvalRequired"); integer(state.discoveryRound, "discoveryRound", 0, 2);
  if (typeof state.phase !== "string" || !PHASES.has(state.phase)) invalid("phase");
  const phase = state.phase; const discoveryMinimum = phase === "classified" ? 0 : 1;
  const workItems = items(state.workItems, "workItems", 16, validateWorkItem, discoveryMinimum); const workItemIds = new Set<string>();
  for (const [index, workItem] of workItems.entries()) { const item = record(workItem, `workItems[${index}]`); const id = text(item.id, `workItems[${index}].id`, 48); if (workItemIds.has(id)) invalid(`workItems[${index}].id`); workItemIds.add(id); }
  strings(state.acceptanceCriteria, "acceptanceCriteria", 32, 4_000, discoveryMinimum);
  const findings = items(state.findings, "findings", 16, validateFinding); const findingIds = new Set<string>();
  for (const [index, findingValue] of findings.entries()) { const finding = record(findingValue, `findings[${index}]`); const workItemId = text(finding.workItemId, `findings[${index}].workItemId`, 48); if (!workItemIds.has(workItemId) || findingIds.has(workItemId)) invalid(`findings[${index}].workItemId`); findingIds.add(workItemId); }
  const changes = items(state.changes, "changes", 6, validateChange); for (const [index, changeValue] of changes.entries()) { const change = record(changeValue, `changes[${index}]`); if (change.kind !== (index === 0 ? "implementation" : "repair")) invalid(`changes[${index}].kind`); }
  const plan = optional(state.plan, validateExecutionPlan);
  const changeResults = state.changeResults === undefined ? [] : items(state.changeResults, "changeResults", 16, validateChangeResult);
  const latestChangeResult = changeResults.at(-1);
  const latestChange = latestChangeResult === undefined ? undefined : record(latestChangeResult, "latest change result");
  const approvalRejected = latestChange?.status === "needs_attention" && latestChange.change === undefined && latestChange.verification === undefined;
  if (plan !== undefined) for (const [index, resultValue] of changeResults.entries()) { const result = record(resultValue, `changeResults[${index}]`); if (typeof result.changeId !== "string" || !plan.changeIds.has(result.changeId)) invalid(`changeResults[${index}].changeId`); }
  if (state.evidenceRefs !== undefined) items(state.evidenceRefs, "evidenceRefs", 256, validateArtifactRef);
  const interrupt = optional(state.interrupt, validateInterrupt);
  if (plan !== undefined && interrupt !== undefined && (interrupt.planId !== plan.planId || interrupt.revision !== plan.revision || !plan.changeIds.has(interrupt.changeId))) invalid("interrupt plan identity");
  const verificationPassed = optional(state.verification, validateVerification); optional(state.diagnostic, validateDiagnostic); optional(state.currentWorkItem, (item) => validateWorkItem(item, "currentWorkItem"));
  const iteration = integer(state.iteration, "iteration", 0, 5); if (iteration > maxIterations || Math.max(0, changes.length - 1) !== iteration) invalid("iteration");
  if (phase === "diagnosed" && iteration >= maxIterations) invalid("diagnosed iteration");
  if (typeof state.status !== "string" || !STATUSES.has(state.status)) invalid("status"); const status = state.status;
  text(state.summary, "summary", 32_000, true); strings(state.unresolvedRisks, "unresolvedRisks", 256, 4_000); items(state.trace, "trace", 128, validateTrace);
  if (pattern === "review" && (maxIterations !== 0 || changes.length !== 0 || state.verification !== undefined)) invalid("review state");
  if ((phase === "synthesized") !== (status === "completed")) invalid("completed phase/status"); if ((phase === "escalated") !== (status === "needs_attention")) invalid("escalated phase/status");
  if (status === "awaiting_approval" && (phase !== "analyzed" || state.approvalRequired !== true)) invalid("approval phase/status"); if (status === "running" && (phase === "synthesized" || phase === "escalated")) invalid("running phase/status"); if (phase === "implemented" && changes.length === 0) invalid("implemented changes");
  if ((phase === "verified" || phase === "diagnosed" || phase === "repaired") && verificationPassed === undefined) invalid("phase verification"); if ((phase === "diagnosed" || phase === "repaired") && state.diagnostic === undefined) invalid("phase diagnostic");
  if (status === "completed") { text(state.summary, "summary", 32_000); if (pattern === "delivery" && (verificationPassed !== true || changes.length === 0)) invalid("completed delivery verification"); }
  if (status === "needs_attention" && (
    pattern !== "delivery" ||
    (!approvalRejected && (verificationPassed !== false || iteration !== maxIterations))
  )) invalid("needs_attention state");
}

export function isPersistedWorkflowChannel(channel: string): boolean { return WORKFLOW_CHANNELS.some((candidate) => candidate === channel); }

export function semanticCheckpointLabels(value: unknown): readonly SemanticCheckpointLabel[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("phase" in value)) return [];
  switch (value.phase) {
    case "analyzed":
      return ["post-discovery", "pre-mutation"];
    case "verified":
    case "synthesized":
      return hasPassedVerification(value) ? ["last-known-green"] : [];
    case "repaired":
      return ["post-repair"];
    default:
      return [];
  }
}

function hasPassedVerification(value: Readonly<Record<string, unknown>>): boolean {
  if (
    "verification" in value && typeof value.verification === "object" && value.verification !== null &&
    "passed" in value.verification && value.verification.passed === true
  ) return true;
  if (!("changeResults" in value) || !Array.isArray(value.changeResults)) return false;
  const latest: unknown = value.changeResults.at(-1);
  return typeof latest === "object" && latest !== null && "verification" in latest &&
    typeof latest.verification === "object" && latest.verification !== null &&
    "passed" in latest.verification && latest.verification.passed === true;
}

export function validatePersistedWorkflowWrite(channel: string, value: unknown): void {
  switch (channel) {
    case "objective": text(value, channel, 12_000); return;
    case "pattern": if (value !== "delivery" && value !== "review") invalid(channel); return;
    case "maxIterations": integer(value, channel, 0, 5); return;
    case "approvalRequired": boolean(value, channel); return;
    case "discoveryRound": integer(value, channel, 0, 2); return;
    case "workItems": items(value, channel, 16, validateWorkItem); return;
    case "acceptanceCriteria": strings(value, channel, 32, 4_000); return;
    case "findings": items(value, channel, 16, validateFinding); return;
    case "changes": items(value, channel, 6, validateChange); return;
    case "verification": optional(value, validateVerification); return;
    case "diagnostic": optional(value, validateDiagnostic); return;
    case "currentWorkItem": optional(value, (item) => validateWorkItem(item, channel)); return;
    case "iteration": integer(value, channel, 0, 5); return;
    case "phase": if (typeof value !== "string" || !PHASES.has(value)) invalid(channel); return;
    case "status": if (typeof value !== "string" || !STATUSES.has(value)) invalid(channel); return;
    case "summary": text(value, channel, 32_000, true); return;
    case "unresolvedRisks": strings(value, channel, 256, 4_000); return;
    case "trace": items(value, channel, 128, validateTrace); return;
    case "plan": optional(value, validateExecutionPlan); return;
    case "changeResults": items(value, channel, 16, validateChangeResult); return;
    case "evidenceRefs": items(value, channel, 256, validateArtifactRef); return;
    case "interrupt": optional(value, validateInterrupt); return;
    default: invalid(`pending channel ${channel}`);
  }
}

export function validatePersistedWorkflowStructure(value: unknown): void {
  const state = record(value, "checkpoint channel_values");
  for (const [channel, channelValue] of Object.entries(state)) {
    if (isPersistedWorkflowChannel(channel)) validatePersistedWorkflowWrite(channel, channelValue);
  }
}

function validateBootstrapChannels(state: Readonly<Record<string, unknown>>): void {
  const defaultChannels = ["workItems", "acceptanceCriteria", "findings", "changes", "unresolvedRisks", "trace"] as const; const optionalArrays = ["changeResults", "evidenceRefs"] as const; const allowed = new Set<string>([...defaultChannels, ...optionalArrays, "plan", "interrupt"]);
  for (const channel of WORKFLOW_CHANNELS) if (hasOwn(state, channel) && !allowed.has(channel)) invalid(`bootstrap ${channel}`);
  for (const channel of defaultChannels) if (!hasOwn(state, channel) || !Array.isArray(state[channel]) || state[channel].length !== 0) invalid(`bootstrap ${channel}`);
  for (const channel of optionalArrays) if (hasOwn(state, channel) && (!Array.isArray(state[channel]) || state[channel].length !== 0)) invalid(`bootstrap ${channel}`);
  for (const channel of ["plan", "interrupt"] as const) if (hasOwn(state, channel) && state[channel] !== null) invalid(`bootstrap ${channel}`);
  const initialState = record(state.__start__, "bootstrap __start__"); if (!hasOwn(initialState, "objective")) invalid("bootstrap objective"); validatePersistedWorkflowChannels(initialState);
}
