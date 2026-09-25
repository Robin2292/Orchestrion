import { describe, expect, it } from "vitest";
import type { UserInputQuestion } from "./contracts";
import {
  buildElicitationContent,
  buildUserInputAnswers,
  initialElicitationFormValues,
  parseElicitationFormSchema,
  userInputAnswersComplete,
  validateElicitationContent,
} from "./request-contracts";

describe("request contracts", () => {
  it("emits a free-form request_user_input alternative in the documented answer shape", () => {
    const questions: UserInputQuestion[] = [{
      id: "destination",
      header: "Destination",
      question: "Where should this go?",
      isOther: true,
      options: [{ label: "Staging" }, { label: "Production" }],
    }];
    expect(buildUserInputAnswers(questions, {
      destination: { kind: "other", value: "Private preview" },
    })).toEqual({ destination: { answers: ["Private preview"] } });
    expect(userInputAnswersComplete(questions, { destination: { kind: "other", value: "" } })).toBe(false);
    expect(userInputAnswersComplete(questions, { destination: { kind: "other", value: "Private preview" } })).toBe(true);
  });

  it("parses primitive MCP form properties and builds typed content", () => {
    const schema = {
      type: "object",
      properties: {
        environment: { type: "string", title: "Environment", enum: ["staging", "production"], default: "staging" },
        retries: { type: "integer", minimum: 0, maximum: 5, default: 2 },
        threshold: { type: "number", minimum: 0 },
        notify: { type: "boolean", default: true },
        note: { type: "string", minLength: 2 },
      },
      required: ["environment", "retries", "notify", "note"],
    };
    const form = parseElicitationFormSchema(schema, "form");
    expect(form.supported).toBe(true);
    if (!form.supported) return;
    const values = { ...initialElicitationFormValues(form), threshold: "0.75", note: "ok" };
    expect(buildElicitationContent(form, values)).toEqual({
      ok: true,
      content: { environment: "staging", retries: 2, threshold: 0.75, notify: true, note: "ok" },
    });
  });

  it("fails closed for unsupported MCP form schemas", () => {
    const requestedSchema = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } };
    expect(parseElicitationFormSchema(requestedSchema, "form")).toEqual({
      supported: false,
      reason: "Field tags uses unsupported type array.",
    });
    expect(validateElicitationContent({ elicitation: { mode: "form", serverName: "demo", message: "Tags", requestedSchema } }, { tags: [] })).toBe(false);
  });

  it("requires URL-mode acceptance to carry null content", () => {
    const request = { elicitation: { mode: "url" as const, serverName: "demo", message: "Authorize", url: "https://example.com", elicitationId: "flow-1" } };
    expect(validateElicitationContent(request, null)).toBe(true);
    expect(validateElicitationContent(request, { response: "done" })).toBe(false);
  });
});
