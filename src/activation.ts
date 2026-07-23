type InputSource = "extension" | "interactive" | "rpc";

export type UlwInputResult =
  | { readonly action: "continue" }
  | { readonly action: "dispatch"; readonly objective: string };

export function routeUlwInput(text: string, source: InputSource): UlwInputResult {
  if (source === "extension") return { action: "continue" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { action: "continue" };

  const tokens = trimmed.split(/\s+/u);
  const markers = tokens.filter((token) => token.toLowerCase() === "ulw");
  if (markers.length !== 1) return { action: "continue" };

  const objective = tokens.filter((token) => token.toLowerCase() !== "ulw").join(" ");
  if (!/[\p{L}\p{N}]/u.test(objective)) return { action: "continue" };
  return { action: "dispatch", objective };
}
