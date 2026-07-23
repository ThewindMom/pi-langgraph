import { createTaskExecutor } from "../executors.ts";
import type {
  CandidateTieCritic,
  CandidateTieCriticInput,
} from "../workflow/candidate-scoring.ts";
import type { LangGraphExtensionAPI, RuntimeContext } from "../types.ts";

export type RuntimeTieCriticInput = Readonly<{
  pi: LangGraphExtensionAPI;
  context: RuntimeContext;
  signal?: AbortSignal;
}>;

export function createRuntimeTieCritic(input: RuntimeTieCriticInput): CandidateTieCritic {
  const executor = createTaskExecutor(input.pi, input.context);
  return async (decision) => {
    const output = await executor.execute({
      objective: "Resolve an exact candidate-score tie using the supplied structured receipts.",
      task: {
        id: "candidate_tie_critic",
        prompt: criticInstruction(decision),
      },
      dependencyResults: [],
    }, input.signal);
    return parseJson(output);
  };
}

function criticInstruction(input: CandidateTieCriticInput): string {
  return JSON.stringify({
    protocolVersion: 1,
    decisionSchema: { protocolVersion: 1, winnerCandidateIndex: "0 | 1" },
    candidates: input.candidates,
    constraints: [
      "Return exactly one JSON object conforming to decisionSchema.",
      "Select only one supplied candidate index.",
      "Do not modify the repository or invoke tools beyond read-only inspection.",
    ],
  });
}

function parseJson(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}
