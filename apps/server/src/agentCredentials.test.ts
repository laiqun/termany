import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { overriddenCredentials, subscriptionEnvironment } from "./agentCredentials.js";

const claude = {
  id: "claude",
  runtime: { command: "npx", args: "-y @agentclientprotocol/claude-agent-acp" },
};
const codex = {
  id: "codex",
  runtime: { command: "npx", args: "-y @agentclientprotocol/codex-acp" },
};
const opencode = { id: "opencode", runtime: { command: "opencode", args: "acp" } };

const shell = {
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "sk-ant-test",
  ANTHROPIC_AUTH_TOKEN: "token",
  OPENAI_API_KEY: "sk-openai-test",
  CODEX_API_KEY: "codex-test",
};

describe("subscriptionEnvironment", () => {
  test("drops the Anthropic credentials that outrank Claude's own login", () => {
    const env = subscriptionEnvironment(shell, claude);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    // Another vendor's key is none of Claude's business, but leaving it lets an
    // MCP server or hook the agent runs keep working.
    assert.equal(env.OPENAI_API_KEY, "sk-openai-test");
    assert.equal(env.PATH, "/usr/bin");
  });

  test("drops the OpenAI credentials that outrank Codex's own login", () => {
    const env = subscriptionEnvironment(shell, codex);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.CODEX_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-test");
  });

  test("leaves OpenCode alone — env keys are how it is configured", () => {
    const env = subscriptionEnvironment(shell, opencode);
    assert.deepEqual(env, shell);
  });

  test("matches a custom agent by its adapter rather than its id", () => {
    const env = subscriptionEnvironment(shell, {
      id: "my-assistant",
      runtime: { command: "npx", args: "-y @zed-industries/claude-code-acp" },
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  test("never mutates the environment it was handed", () => {
    const source = { ...shell };
    subscriptionEnvironment(source, claude);
    assert.deepEqual(source, shell);
  });

  test("is a no-op for an agent with no runtime", () => {
    assert.deepEqual(subscriptionEnvironment(shell, { id: "kimi" }), shell);
    assert.deepEqual(overriddenCredentials({ id: "kimi" }), []);
  });

  test("reports what it would drop", () => {
    assert.deepEqual(overriddenCredentials(claude), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    assert.deepEqual(overriddenCredentials(opencode), []);
  });
});
