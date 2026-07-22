import { boolean, integer, invalid, items, optional, record, strings, text } from "./workflow-validation-primitives.js";
import { validateChange, validateDiagnostic, validateFinding, validateTrace, validateVerification, validateWorkItem } from "./workflow-state-field-validation.js";

const PHASES = new Set(["classified", "discovered", "analyzed", "implemented", "verified", "diagnosed", "repaired", "synthesized", "escalated"]);
const STATUSES = new Set(["running", "awaiting_approval", "completed", "needs_attention"]);
const WORKFLOW_CHANNELS = ["objective", "pattern", "maxIterations", "approvalRequired", "discoveryRound", "workItems", "acceptanceCriteria", "findings", "changes", "verification", "diagnostic", "currentWorkItem", "iteration", "phase", "status", "summary", "unresolvedRisks", "trace"] as const;
const REQUIRED_WORKFLOW_CHANNELS = WORKFLOW_CHANNELS.filter((channel) => channel !== "verification" && channel !== "diagnostic" && channel !== "currentWorkItem");
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
  const verificationPassed = optional(state.verification, validateVerification); optional(state.diagnostic, validateDiagnostic); optional(state.currentWorkItem, (item) => validateWorkItem(item, "currentWorkItem"));
  const iteration = integer(state.iteration, "iteration", 0, 5); if (iteration > maxIterations || Math.max(0, changes.length - 1) !== iteration) invalid("iteration");
  if (typeof state.status !== "string" || !STATUSES.has(state.status)) invalid("status"); const status = state.status;
  text(state.summary, "summary", 32_000, true); strings(state.unresolvedRisks, "unresolvedRisks", 256, 4_000); items(state.trace, "trace", 128, validateTrace);
  if (pattern === "review" && (maxIterations !== 0 || changes.length !== 0 || state.verification !== undefined)) invalid("review state");
  if ((phase === "synthesized") !== (status === "completed")) invalid("completed phase/status"); if ((phase === "escalated") !== (status === "needs_attention")) invalid("escalated phase/status");
  if (status === "awaiting_approval" && (phase !== "analyzed" || state.approvalRequired !== true)) invalid("approval phase/status"); if (status === "running" && (phase === "synthesized" || phase === "escalated")) invalid("running phase/status"); if (phase === "implemented" && changes.length === 0) invalid("implemented changes");
  if ((phase === "verified" || phase === "diagnosed" || phase === "repaired") && verificationPassed === undefined) invalid("phase verification"); if ((phase === "diagnosed" || phase === "repaired") && state.diagnostic === undefined) invalid("phase diagnostic");
  if (status === "completed") { text(state.summary, "summary", 32_000); if (pattern === "delivery" && (verificationPassed !== true || changes.length === 0)) invalid("completed delivery verification"); }
  if (status === "needs_attention" && (pattern !== "delivery" || verificationPassed !== false || iteration !== maxIterations)) invalid("needs_attention state");
}

export function isPersistedWorkflowChannel(channel: string): boolean { return WORKFLOW_CHANNELS.some((candidate) => candidate === channel); }

function validateBootstrapChannels(state: Readonly<Record<string, unknown>>): void {
  const defaultChannels = ["workItems", "acceptanceCriteria", "findings", "changes", "unresolvedRisks", "trace"] as const; const allowed = new Set<string>(defaultChannels);
  for (const channel of WORKFLOW_CHANNELS) if (hasOwn(state, channel) && !allowed.has(channel)) invalid(`bootstrap ${channel}`);
  for (const channel of defaultChannels) if (!hasOwn(state, channel) || !Array.isArray(state[channel]) || state[channel].length !== 0) invalid(`bootstrap ${channel}`);
  const initialState = record(state.__start__, "bootstrap __start__"); if (!hasOwn(initialState, "objective")) invalid("bootstrap objective"); validatePersistedWorkflowChannels(initialState);
}
