import { ALLOWED_TOOLS, type ToolName } from "../controller/model.js";
import { AgentError, type AgentModel } from "./model.js";

export const MOCK_FIXTURES = Object.freeze([
  "all", "memory", "disk", "system", "sequential", "denied-write", "bad-args", "loop",
  "quota", "unavailable", "api-failure", "invalid-response",
] as const);
export type MockFixture = typeof MOCK_FIXTURES[number];
export function isMockFixture(value: string): value is MockFixture {
  return MOCK_FIXTURES.some((fixture) => fixture === value);
}

// Deterministic model-selected function-call fixtures, independent of question wording.
// This is intentionally not presented as live LLM inference.
export function createMockModel(fixture: MockFixture): AgentModel {
  let turn = 0;
  const call = (name: ToolName) => ({ name, args: {} });
  return {
    async prepare() { if (fixture === "unavailable") throw new AgentError("model_unavailable"); },
    async next() {
      turn++;
      if (fixture === "quota") throw new AgentError("model_quota");
      if (fixture === "api-failure") throw new AgentError("model_api");
      if (fixture === "invalid-response") return { requests: [] };
      if (fixture === "denied-write") return { requests: [{ name: "write_lab_note", args: { content: "never executed" } }] };
      if (fixture === "bad-args") return { requests: [{ name: "disk_usage", args: { path: "/never-read" } }] };
      if (fixture === "loop") return { requests: [call("memory_usage")] };
      if (fixture === "sequential" && turn <= 3) return { requests: [call(ALLOWED_TOOLS[turn - 1]!)] };
      if (turn === 1 && fixture !== "sequential") return { requests: fixture === "all" ? ALLOWED_TOOLS.map(call)
        : [call(fixture === "memory" ? "memory_usage" : fixture === "disk" ? "disk_usage" : "system_info")] };
      return { requests: [], answer: "Offline fixture completed. Use the deterministic readiness report for the decision." };
    },
    async close() {},
  };
}
