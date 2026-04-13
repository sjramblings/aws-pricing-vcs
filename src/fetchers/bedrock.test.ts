import { test, expect } from "bun:test";
import { __test__ } from "./bedrock.ts";

const { normaliseProvider } = __test__;

test("normaliseProvider: canonical identity for simple names", () => {
  expect(normaliseProvider("anthropic")).toBe("anthropic");
  expect(normaliseProvider("Anthropic")).toBe("anthropic");
  expect(normaliseProvider("  Anthropic  ")).toBe("anthropic");
});

test("normaliseProvider: whitespace variants map to the same key", () => {
  expect(normaliseProvider("Mistral AI")).toBe("mistral");
  expect(normaliseProvider("mistral-ai")).toBe("mistral");
  expect(normaliseProvider("Mistral_AI")).toBe("mistral");
  expect(normaliseProvider("mistral  ai")).toBe("mistral");
});

test("normaliseProvider: dot-punctuated aliases collapse correctly", () => {
  // The bug: "Z.AI" previously normalised to "z.ai" and missed the z-ai alias,
  // fragmenting a single provider across multiple group keys.
  expect(normaliseProvider("Z.AI")).toBe("zai");
  expect(normaliseProvider("z-ai")).toBe("zai");
  expect(normaliseProvider("zai")).toBe("zai");
  expect(normaliseProvider("Z AI")).toBe("zai");
});

test("normaliseProvider: other multi-word provider aliases collapse", () => {
  expect(normaliseProvider("Moonshot AI")).toBe("moonshot");
  expect(normaliseProvider("Moonshot.AI")).toBe("moonshot");
  expect(normaliseProvider("Kimi AI")).toBe("moonshot");
  expect(normaliseProvider("MiniMax AI")).toBe("minimax");
  expect(normaliseProvider("MiniMax.AI")).toBe("minimax");
});

test("normaliseProvider: unknown providers pass through sanitised", () => {
  expect(normaliseProvider("Some.New Provider")).toBe("some-new-provider");
  expect(normaliseProvider("---foo---")).toBe("foo");
});
