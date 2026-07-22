import { TOOL_NAME } from "./types.ts";

type InputSource = "extension" | "interactive" | "rpc";

export type UlwInputResult =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly text: string };

const XML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function routeUlwInput(text: string, source: InputSource): UlwInputResult {
  if (source === "extension") return { action: "continue" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { action: "continue" };

  const tokens = trimmed.split(/\s+/u);
  const markers = tokens.filter((token) => token.toLowerCase() === "ulw");
  if (markers.length !== 1) return { action: "continue" };

  const objective = tokens.filter((token) => token.toLowerCase() !== "ulw").join(" ");
  if (objective.length === 0) return { action: "continue" };
  const escapedObjective = objective.replace(/[&<>]/gu, (character) => XML_ESCAPES[character] ?? character);

  return {
    action: "transform",
    text: '<pi-langgraph mode="ulw" tool="' + TOOL_NAME + '">\n<objective>' + escapedObjective + '</objective>\n</pi-langgraph>',
  };
}
