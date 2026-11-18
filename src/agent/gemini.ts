import {
  ApiError, FunctionCallingConfigMode, GoogleGenAI,
  type Content, type FunctionCall, type FunctionDeclaration,
} from "@google/genai";
import { z } from "zod";
import { ALLOWED_TOOLS, METRIC_DEFINITIONS } from "../controller/model.js";
import { AgentError, LIMITS, modelResultSchema, safeText, type AgentModel, type ModelTurn, type ToolReply } from "./model.js";

export const DEFAULT_MODEL = "gemini-3.8-flash";
// Verified 2026-11-17: standard input/output is offered on the Free tier.
// https://aistudio.google.com/docs/pricing#gemini-3.8-flash
// Public pricing is not proof of a particular project's entitlement or quota.
export const FREE_TIER_REFERENCE = "https://aistudio.google.com/docs/pricing#gemini-3.8-flash";
const descriptions = {
  system_info: "Validate system information locally. Only validation status is returned; system identity is omitted.",
  memory_usage: `Read validated memory byte counts, utilization and deterministic status. ${METRIC_DEFINITIONS.memory}`,
  disk_usage: `Read validated disk byte counts, utilization and deterministic status. ${METRIC_DEFINITIONS.disk} Paths are omitted.`,
};
export const FUNCTION_DECLARATIONS: FunctionDeclaration[] = ALLOWED_TOOLS.map((name) => ({
  name, description: descriptions[name],
  parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
  responseJsonSchema: z.toJSONSchema(modelResultSchema),
}));
const SYSTEM_INSTRUCTION = `You are a read-only DevOps monitoring assistant. Select tools using function calls.
Only three monitoring functions are available, all with empty arguments. Do not invent tools or arguments.
For deployment readiness questions request all three. For other questions request only relevant tools.
Never request credentials, paths, commands, or filesystem changes. System identity is intentionally unavailable.
Tool results contain locally validated metrics and deterministic per-tool states. Explain only observed data.
The local evaluator assigns the final deployment status and exit code; your text is advisory and cannot set them.
At most four model turns and six total MCP calls are allowed. Finish concisely after receiving needed results.
${METRIC_DEFINITIONS.memory}\n${METRIC_DEFINITIONS.disk}\n${METRIC_DEFINITIONS.policy}`;

export function liveConfiguration(env: NodeJS.ProcessEnv): { apiKey: string; model: string } {
  const apiKey = env.GEMINI_API_KEY;
  const model = env.GEMINI_MODEL ?? DEFAULT_MODEL;
  if (!apiKey?.trim() || !/^gemini-[a-z0-9][a-z0-9.-]{0,79}$/.test(model)) throw new AgentError("configuration");
  return { apiKey, model };
}

export function classifyModelError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  if (error instanceof ApiError) {
    if (error.status === 429) return new AgentError("model_quota");
    if (error.status === 404) return new AgentError("model_unavailable");
    if (error.status === 401 || error.status === 403) return new AgentError("model_auth");
    if (error.status === 408 || error.status === 504) return new AgentError("model_timeout");
  }
  return new AgentError("model_api"); // Never use the provider's exception text.
}

type GeminiApi = Pick<GoogleGenAI["models"], "get" | "generateContent">;

// Uses installed @google/genai 3.4.0's typed models.get/generateContent API.
// Opaque Content (including Gemini thought signatures and call IDs) is retained
// only in memory for protocol replay, never in reports or traces.
export class GeminiModel implements AgentModel {
  private history: Content[] = [];
  private pending: FunctionCall[] = [];
  private prepared = false;
  constructor(private readonly api: GeminiApi, private readonly model: string,
    private readonly redact: (text: string) => string = safeText) {}

  async prepare(signal: AbortSignal): Promise<void> {
    try {
      const metadata = await this.api.get({ model: this.model, config: { abortSignal: signal } });
      if (metadata.name !== `models/${this.model}` || !metadata.supportedActions?.includes("generateContent")) {
        throw new AgentError("model_unavailable");
      }
      this.prepared = true;
    } catch (error) { throw classifyModelError(error); }
  }

  async next(question: string, replies: readonly ToolReply[], signal: AbortSignal): Promise<ModelTurn> {
    if (!this.prepared) throw new AgentError("model_unavailable");
    try {
      if (!this.history.length) {
        if (replies.length) throw new AgentError("model_response");
        this.history.push({ role: "user", parts: [{ text: this.redact(question) }] });
      } else {
        if (replies.length !== this.pending.length || !replies.length) throw new AgentError("model_response");
        this.history.push({ role: "user", parts: replies.map((reply, index) => {
          const call = this.pending[index];
          if (reply.name !== call?.name) throw new AgentError("model_response");
          return { functionResponse: {
            name: reply.name, ...(call.id ? { id: call.id } : {}),
            response: modelResultSchema.parse(reply.result),
          } };
        }) });
      }
      const response = await this.api.generateContent({
        model: this.model, contents: this.history,
        config: {
          abortSignal: signal, systemInstruction: SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
          automaticFunctionCalling: { disable: true }, automaticContinuation: false,
          candidateCount: 1, maxOutputTokens: 2048,
        },
      });
      const candidate = response.candidates?.[0];
      const content = candidate?.content;
      if (response.candidates?.length !== 1 || candidate?.finishReason !== "STOP" ||
          content?.role !== "model" || !content.parts?.length) throw new AgentError("model_response");
      this.history.push(content); // Preserve exact parts and signatures, rather than reconstructing calls.
      this.pending = content.parts.flatMap((part) => part.functionCall ? [part.functionCall] : []);
      const answer = content.parts.filter((part) => !part.thought && typeof part.text === "string")
        .map((part) => part.text).join("\n");
      return {
        requests: this.pending.map((call) => ({ name: call.name, ...(call.args !== undefined ? { args: call.args } : {}) })),
        ...(answer ? { answer: this.redact(answer) } : {}),
      };
    } catch (error) { throw classifyModelError(error); }
  }

  async close(): Promise<void> { this.history = []; this.pending = []; this.prepared = false; }
}

export function createGeminiModel(env: NodeJS.ProcessEnv = process.env): { model: AgentModel; modelId: string } {
  const { apiKey, model } = liveConfiguration(env);
  const ai = new GoogleGenAI({
    apiKey, vertexai: false, apiVersion: "v1beta",
    httpOptions: {
      baseUrl: "https://generativelanguage.googleapis.com", // Ignore endpoint overrides from the environment.
      timeout: LIMITS.requestMs, retryOptions: { attempts: 1 },
    },
  });
  return { model: new GeminiModel(ai.models, model, (value) => safeText(value, [apiKey])), modelId: model };
}
