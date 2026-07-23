import { randomUUID } from "node:crypto";
import {
  decodeManagedWorktreeRef,
  decodeSessionCheckpointLink,
  piCheckpointDisplayLabel,
  sha256CanonicalJson,
} from "./codec.ts";
import {
  type BridgeIntentRecord,
  type BridgeIntentStore,
  BridgeIntentStoreError,
  type PreparedIntentBinding,
} from "./store.ts";
import {
  type BridgeResourceResolver,
  type PiCheckpointHost,
  PiSessionBridgeError,
  type PiSessionReader,
  type ResolvedCheckpointLink,
} from "./session-checkpoint-contract.ts";
import {
  BridgeContractError,
  PI_CHECKPOINT_LINK_ENTRY_TYPE,
  type ManagedWorktreeRefV1,
  type SessionCheckpointLinkV1,
} from "./types.ts";

export class PiSessionCheckpointBridge {
  private links = new Map<string, ResolvedCheckpointLink>();
  private ready = false;
  constructor(
    private readonly session: PiSessionReader,
    private readonly host: PiCheckpointHost,
    private readonly store: BridgeIntentStore,
    private readonly resources: BridgeResourceResolver,
  ) {}
  async rehydrate(): Promise<readonly ResolvedCheckpointLink[]> {
    const sessionId = validIdentity(this.session.getSessionId(), "session");
    const staged = new Map<string, ResolvedCheckpointLink>();
    for (const entry of this.session.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== PI_CHECKPOINT_LINK_ENTRY_TYPE) continue;
      const entryId = validIdentity(entry.id, "entry");
      let link: SessionCheckpointLinkV1;
      try {
        link = decodeSessionCheckpointLink(entry.data);
      } catch (error) {
        if (error instanceof BridgeContractError) {
          throw new PiSessionBridgeError("malformed-link", entryId);
        }
        throw error;
      }
      await this.assertResources(link, entryId);
      const key = checkpointLinkKey(sessionId, entryId);
      const existing = staged.get(key);
      if (existing !== undefined && sha256CanonicalJson(existing.link) !== sha256CanonicalJson(link)) {
        throw new PiSessionBridgeError("conflicting-link", entryId);
      }
      staged.set(key, { sessionId, entryId, link });
    }
    this.links = staged;
    this.ready = true;
    return [...staged.values()];
  }
  async appendLink(value: SessionCheckpointLinkV1): Promise<string> {
    await this.ensureReady();
    let link: SessionCheckpointLinkV1;
    try {
      link = decodeSessionCheckpointLink(value);
    } catch (error) {
      if (error instanceof BridgeContractError) throw new PiSessionBridgeError("malformed-link", "new-entry");
      throw error;
    }
    await this.assertResources(link, "new-entry");
    const previousLeaf = this.session.getLeafId();
    this.host.appendEntry(PI_CHECKPOINT_LINK_ENTRY_TYPE, link);
    const entryId = this.session.getLeafId();
    if (entryId === null || entryId === previousLeaf) throw new PiSessionBridgeError("append-failed", "new-entry");
    const entry = this.session.getEntry(entryId);
    if (entry?.type !== "custom" || entry.customType !== PI_CHECKPOINT_LINK_ENTRY_TYPE) {
      throw new PiSessionBridgeError("append-failed", entryId);
    }
    let durable: SessionCheckpointLinkV1;
    try {
      durable = decodeSessionCheckpointLink(entry.data);
    } catch (error) {
      if (error instanceof BridgeContractError) throw new PiSessionBridgeError("append-failed", entryId);
      throw error;
    }
    if (sha256CanonicalJson(durable) !== sha256CanonicalJson(link)) {
      throw new PiSessionBridgeError("append-failed", entryId);
    }
    const sessionId = validIdentity(this.session.getSessionId(), "session");
    const key = checkpointLinkKey(sessionId, entryId);
    const existing = this.links.get(key);
    if (existing !== undefined && sha256CanonicalJson(existing.link) !== sha256CanonicalJson(durable)) {
      throw new PiSessionBridgeError("conflicting-link", entryId);
    }
    this.links.set(key, { sessionId, entryId, link: durable });
    this.host.setLabel(entryId, piCheckpointDisplayLabel(durable));
    return entryId;
  }
  async resolveTarget(targetEntryId: string): Promise<ResolvedCheckpointLink> {
    await this.ensureReady();
    const sessionId = validIdentity(this.session.getSessionId(), "session");
    let entry = this.session.getEntry(validIdentity(targetEntryId, "target"));
    if (entry === undefined) throw new PiSessionBridgeError("missing-target", targetEntryId);
    const visited = new Set<string>();
    while (true) {
      if (visited.has(entry.id)) throw new PiSessionBridgeError("malformed-session", entry.id);
      visited.add(entry.id);
      const linked = this.links.get(checkpointLinkKey(sessionId, entry.id));
      if (linked !== undefined) {
        await this.assertResources(linked.link, linked.entryId);
        return linked;
      }
      if (entry.parentId === null) break;
      const parent = this.session.getEntry(entry.parentId);
      if (parent === undefined) throw new PiSessionBridgeError("malformed-session", entry.parentId);
      entry = parent;
    }
    throw new PiSessionBridgeError("missing-link", targetEntryId);
  }
  async prepareTree(targetEntryId: string, ttlMs: number): Promise<BridgeIntentRecord> {
    const resolved = await this.resolveTarget(targetEntryId);
    return this.prepare("tree", targetEntryId, resolved, resolved.link.managedWorktree ?? null, ttlMs);
  }
  async prepareFork(
    targetEntryId: string,
    worktreeValue: ManagedWorktreeRefV1,
    ttlMs: number,
  ): Promise<BridgeIntentRecord> {
    const resolved = await this.resolveTarget(targetEntryId);
    const worktree = decodeManagedWorktreeRef(worktreeValue);
    if (!await this.resources.managedWorktreeExists(worktree)) {
      throw new PiSessionBridgeError("stale-worktree", targetEntryId);
    }
    return this.prepare("fork", targetEntryId, resolved, worktree, ttlMs);
  }
  async consumePreparedFork(
    intentId: string,
    worktreeValue: ManagedWorktreeRefV1,
  ): Promise<BridgeIntentRecord> {
    const worktree = decodeManagedWorktreeRef(worktreeValue);
    const current = await this.store.get(intentId);
    if (current === undefined) throw new BridgeIntentStoreError("missing-intent", intentId);
    if (current.kind !== "fork") throw new BridgeIntentStoreError("intent-mismatch", intentId);
    await this.assertResources(current.link, current.resolvedEntryId);
    if (!await this.resources.managedWorktreeExists(worktree)) {
      throw new PiSessionBridgeError("stale-worktree", current.targetEntryId);
    }
    return this.store.consume(intentId, { ...bindingOf(current), managedWorktree: worktree });
  }
  async consumePreparedTree(intentId: string, targetEntryId: string): Promise<BridgeIntentRecord> {
    const current = await this.store.get(intentId);
    if (current === undefined) throw new BridgeIntentStoreError("missing-intent", intentId);
    if (current.kind !== "tree" || current.targetEntryId !== targetEntryId) {
      throw new BridgeIntentStoreError("intent-mismatch", intentId);
    }
    const resolved = await this.resolveTarget(targetEntryId);
    const expected = {
      kind: "tree",
      sessionId: resolved.sessionId,
      targetEntryId,
      resolvedEntryId: resolved.entryId,
      linkKey: checkpointLinkKey(resolved.sessionId, resolved.entryId),
      linkDigest: sha256CanonicalJson(resolved.link),
      link: resolved.link,
      managedWorktree: resolved.link.managedWorktree ?? null,
    } satisfies PreparedIntentBinding;
    return this.store.consume(intentId, expected);
  }
  private async prepare(
    kind: "tree" | "fork",
    targetEntryId: string,
    resolved: ResolvedCheckpointLink,
    managedWorktree: ManagedWorktreeRefV1 | null,
    ttlMs: number,
  ): Promise<BridgeIntentRecord> {
    const binding = {
      kind,
      sessionId: resolved.sessionId,
      targetEntryId,
      resolvedEntryId: resolved.entryId,
      linkKey: checkpointLinkKey(resolved.sessionId, resolved.entryId),
      linkDigest: sha256CanonicalJson(resolved.link),
      link: resolved.link,
      managedWorktree,
    } satisfies PreparedIntentBinding;
    return this.store.prepare({ intentId: randomUUID(), binding, ttlMs });
  }
  private async assertResources(link: SessionCheckpointLinkV1, entryId: string): Promise<void> {
    if (!await this.resources.checkpointExists(link)) throw new PiSessionBridgeError("stale-link", entryId);
    if (link.managedWorktree !== undefined && !await this.resources.managedWorktreeExists(link.managedWorktree)) {
      throw new PiSessionBridgeError("stale-worktree", entryId);
    }
  }
  private async ensureReady(): Promise<void> {
    if (!this.ready) await this.rehydrate();
    if (!this.ready) throw new PiSessionBridgeError("not-ready", this.session.getSessionId());
  }
}

export function checkpointLinkKey(sessionId: string, entryId: string): string {
  return sha256CanonicalJson([validIdentity(sessionId, "session"), validIdentity(entryId, "entry")]);
}

function bindingOf(record: BridgeIntentRecord): PreparedIntentBinding {
  return {
    kind: record.kind,
    sessionId: record.sessionId,
    targetEntryId: record.targetEntryId,
    resolvedEntryId: record.resolvedEntryId,
    linkKey: record.linkKey,
    linkDigest: record.linkDigest,
    link: record.link,
    managedWorktree: record.managedWorktree,
  };
}

function validIdentity(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/.test(value)) {
    throw new PiSessionBridgeError("malformed-session", field);
  }
  return value;
}

export {
  type BridgeResourceResolver,
  type PiCheckpointHost,
  PiSessionBridgeError,
  type PiSessionBridgeErrorCode,
  type PiSessionEntry,
  type PiSessionReader,
  type ResolvedCheckpointLink,
} from "./session-checkpoint-contract.ts";
