import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "../persistence/file-lock.ts";
import {
  BRIDGE_INTENT_STORE_VERSION,
  type BridgeIntentRecord,
  BridgeIntentStoreError,
  createIntentRecord,
  expireIntents,
  parseIntentStore,
  type PreparedIntentBinding,
  safeIntentTime,
  sameIntentBinding,
} from "./store-format.ts";
import { BridgeContractError } from "./types.ts";

const STORE_FILE = "prepared-intents-v1.json";
const MAX_STORE_BYTES = 1024 * 1024;

export class BridgeIntentStore {
  private constructor(
    private readonly root: string,
    private readonly clock: () => number,
  ) {}

  static async open(
    root: string,
    options: Readonly<{ clock?: () => number }> = {},
  ): Promise<BridgeIntentStore> {
    const directory = resolve(root);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    return new BridgeIntentStore(directory, options.clock ?? Date.now);
  }

  async prepare(
    input: Readonly<{ intentId: string; binding: PreparedIntentBinding; ttlMs: number }>,
  ): Promise<BridgeIntentRecord> {
    return this.locked(async () => {
      const records = await this.read();
      const now = this.now();
      const reconciled = expireIntents(records, now);
      const candidate = createIntentRecord(input, now);
      const existing = reconciled.records.find((record) => record.intentId === input.intentId);
      if (existing !== undefined) {
        if (existing.status.kind === "prepared" && sameIntentBinding(existing, input.binding)) {
          if (reconciled.changed) await this.write(reconciled.records);
          return existing;
        }
        if (reconciled.changed) await this.write(reconciled.records);
        throw new BridgeIntentStoreError("intent-conflict", input.intentId);
      }
      const updated = [...reconciled.records, candidate];
      await this.write(updated);
      return candidate;
    });
  }

  async consume(intentId: string, expected: PreparedIntentBinding): Promise<BridgeIntentRecord> {
    return this.locked(async () => {
      const reconciled = expireIntents(await this.read(), this.now());
      const index = reconciled.records.findIndex((record) => record.intentId === intentId);
      const current = reconciled.records[index];
      if (current === undefined) {
        if (reconciled.changed) await this.write(reconciled.records);
        throw new BridgeIntentStoreError("missing-intent", intentId);
      }
      if (!sameIntentBinding(current, expected)) {
        if (reconciled.changed) await this.write(reconciled.records);
        throw new BridgeIntentStoreError("intent-mismatch", intentId);
      }
      if (current.status.kind === "expired") {
        if (reconciled.changed) await this.write(reconciled.records);
        throw new BridgeIntentStoreError("expired-intent", intentId);
      }
      if (current.status.kind === "consumed") {
        if (reconciled.changed) await this.write(reconciled.records);
        return current;
      }
      const consumed = {
        ...current,
        status: { kind: "consumed", consumedAtMs: this.now() },
      } satisfies BridgeIntentRecord;
      const updated = reconciled.records.map((record, position) => position === index ? consumed : record);
      await this.write(updated);
      return consumed;
    });
  }

  async get(intentId: string): Promise<BridgeIntentRecord | undefined> {
    return this.locked(async () => {
      const reconciled = expireIntents(await this.read(), this.now());
      if (reconciled.changed) await this.write(reconciled.records);
      return reconciled.records.find((record) => record.intentId === intentId);
    });
  }

  async list(): Promise<readonly BridgeIntentRecord[]> {
    return this.locked(async () => {
      const reconciled = expireIntents(await this.read(), this.now());
      if (reconciled.changed) await this.write(reconciled.records);
      return reconciled.records;
    });
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.root, "pi-langgraph-bridge-intents", operation);
  }

  private now(): number {
    const now = this.clock();
    if (!safeIntentTime(now)) throw new BridgeIntentStoreError("invalid-intent", "clock");
    return now;
  }

  private async read(): Promise<readonly BridgeIntentRecord[]> {
    let bytes: Uint8Array;
    try {
      bytes = await readFile(join(this.root, STORE_FILE));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    if (bytes.byteLength > MAX_STORE_BYTES) throw new BridgeIntentStoreError("corrupt-store", STORE_FILE);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof SyntaxError) throw new BridgeIntentStoreError("corrupt-store", STORE_FILE);
      throw error;
    }
    try {
      return parseIntentStore(value);
    } catch (error) {
      if (error instanceof BridgeContractError) throw new BridgeIntentStoreError("corrupt-store", STORE_FILE);
      throw error;
    }
  }

  private async write(records: readonly BridgeIntentRecord[]): Promise<void> {
    const path = join(this.root, STORE_FILE);
    const temporary = join(this.root, `.${STORE_FILE}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ protocolVersion: BRIDGE_INTENT_STORE_VERSION, intents: records })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(this.root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

export {
  type BridgeIntentRecord,
  BridgeIntentStoreError,
  type BridgeIntentStoreErrorCode,
  type PreparedIntentBinding,
  type PreparedIntentKind,
  type PreparedIntentStatus,
} from "./store-format.ts";
