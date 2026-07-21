import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import langGraphExtension from "../src/index.ts";

test("registers automatic orchestration guidance for the primary Pi model", () => {
  let registered: { name: string; promptGuidelines?: string[] } | undefined;
  const pi = {
    registerTool(tool: { name: string; promptGuidelines?: string[] }) {
      registered = tool;
    },
  } as unknown as ExtensionAPI;

  langGraphExtension(pi);

  expect(registered?.name).toBe("langgraph_orchestrate");
  expect(registered?.promptGuidelines?.join("\n")).toContain("Silently classify every user request");
  expect(registered?.promptGuidelines?.join("\n")).toContain("Do not require the user to name this tool");
  expect(registered?.promptGuidelines?.join("\n")).toContain("Do not call langgraph_orchestrate for a single focused task");
});
