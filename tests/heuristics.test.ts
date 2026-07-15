import { describe, expect, test } from "bun:test";
import {
  buildContent, classifyScope, heuristicPolarity, scrub, shouldDeposit, turnKey,
} from "../lib/capture";

describe("shouldDeposit", () => {
  test("empty / chatter / short are skipped", () => {
    expect(shouldDeposit("")[0]).toBe(false);
    expect(shouldDeposit("ok")[0]).toBe(false);
    expect(shouldDeposit("thanks!")[0]).toBe(false);
    expect(shouldDeposit("run the tests")[0]).toBe(false);
    expect(shouldDeposit("do it")[0]).toBe(false);
    expect(shouldDeposit("hi there")[0]).toBe(false); // < 4 words, no signal
  });
  test("signal phrases pass even when short", () => {
    expect(shouldDeposit("always use pnpm")[0]).toBe(true);
    expect(shouldDeposit("prefer X")[0]).toBe(true);
    expect(shouldDeposit("decided on Postgres")[0]).toBe(true);
  });
  test("substantive prose passes", () => {
    expect(shouldDeposit("the deploy pipeline runs on a self-hosted runner")[0]).toBe(true);
  });
  test("recall-REQUESTS are skipped even though they trip a signal keyword", () => {
    // real over-capture cases from the Cursor E2E: "use" and "prefer" rescued these
    expect(shouldDeposit("Use your Atlaso memory to recall what my favorite test phrase is.")).toEqual([false, "meta_recall"]);
    expect(shouldDeposit("Recall from my Atlaso memory: what visual style do I prefer for X posts?")).toEqual([false, "meta_recall"]);
    expect(shouldDeposit("what's my favorite test phrase?")).toEqual([false, "meta_recall"]);
    expect(shouldDeposit("do you remember my deploy setup?")).toEqual([false, "meta_recall"]);
    expect(shouldDeposit("check your memory for our package manager")).toEqual([false, "meta_recall"]);
  });
  test("genuine declarative facts still pass (not mistaken for recall-requests)", () => {
    expect(shouldDeposit("remember to always use pnpm in this repo")[0]).toBe(true);
    expect(shouldDeposit("my favorite package manager is pnpm")[0]).toBe(true);
    expect(shouldDeposit("we decided to use Postgres for the main store")[0]).toBe(true);
  });
});

describe("scrub", () => {
  test("redacts an OpenAI/Anthropic-style key", () => {
    const [out, kinds] = scrub("my key is sk-abc123def456ghi789jkl000");
    expect(out).not.toContain("sk-abc123def456ghi789jkl000");
    expect(out).toContain("[REDACTED");
    expect(kinds).toContain("openai_anthropic_key");
  });
  test("redacts a GitHub token and an AWS key", () => {
    expect(scrub("ghp_" + "a".repeat(36))[0]).toContain("[REDACTED");
    expect(scrub("AKIAIOSFODNN7EXAMPLE")[0]).toContain("[REDACTED");
  });
  test("masks an assignment value but keeps the key name", () => {
    const [out] = scrub("API_KEY=supersecretvalue123");
    expect(out).toBe("API_KEY=[REDACTED]");
  });
  test("masks only the password in a credentialed URI", () => {
    const [out] = scrub("postgres://user:hunter2pass@db.example.com/app");
    expect(out).toContain("postgres://user:[REDACTED]@db.example.com/app");
  });
  test("redacts a high-entropy blob", () => {
    const [out, kinds] = scrub("token aZ9xQ2wE7rT4yU6iO1pL8kJ3hG5fD0sA7zX2cV4bN");
    expect(kinds).toContain("high_entropy");
    expect(out).toContain("[REDACTED:high_entropy]");
  });
  test("redacts a quoted secret value with spaces", () => {
    expect(scrub('PASSWORD="correct horse battery staple"')[0]).toBe("PASSWORD=[REDACTED]");
    expect(scrub("api_key: 'long secret with spaces'")[0]).toBe("api_key=[REDACTED]");
  });
  test("leaves ordinary prose untouched", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(scrub(text)[0]).toBe(text);
  });
});

describe("classifyScope", () => {
  test("project signals", () => {
    expect(classifyScope("the database runs on port 5432")).toBe("project");
    expect(classifyScope("in this repo we use squash merges")).toBe("project");
  });
  test("personal signals", () => {
    expect(classifyScope("I prefer dark mode everywhere")).toBe("personal");
    expect(classifyScope("my preferred editor is neovim")).toBe("personal");
  });
  test("defaults to project (contain locally)", () => {
    expect(classifyScope("some neutral statement about nothing")).toBe("project");
  });
});

describe("turnKey (per-turn idempotency)", () => {
  const user = "we standardized on pnpm for this repo";
  test("keys on the USER message — the assistant note can't change it (stop vs sessionEnd race → ONE memory)", () => {
    // stop may deposit user-only; a late afterAgentResponse → sessionEnd deposits
    // user+assistant. buildContent differs, but the key must NOT — it's user-derived.
    const stopKey = turnKey(user, "project", "p1");
    const sessionEndKey = turnKey(user, "project", "p1"); // same user, different assembled content upstream
    expect(stopKey).toBe(sessionEndKey);
    expect(stopKey).toHaveLength(32);
  });
  test("distinct by scope and project (same statement, different attribution)", () => {
    expect(turnKey(user, "project", "p1")).not.toBe(turnKey(user, "project", "p2"));
    expect(turnKey(user, "project", "p1")).not.toBe(turnKey(user, "personal", null));
    expect(turnKey(user, "personal", null)).not.toBe(turnKey("different statement", "personal", null));
  });
});

describe("heuristicPolarity / buildContent", () => {
  test("polarity hints", () => {
    expect(heuristicPolarity("never commit to main")).toBe("cautionary");
    expect(heuristicPolarity("always use pnpm")).toBe("positive");
    expect(heuristicPolarity("the file is at src/x")).toBe("open");
  });
  test("buildContent appends a truncated assistant note", () => {
    expect(buildContent("u", "")).toBe("u");
    expect(buildContent("u", "a")).toBe("u\n\n(assistant: a)");
    expect(buildContent("u", "x".repeat(500))).toContain("x".repeat(400));
    expect(buildContent("u", "x".repeat(500))).not.toContain("x".repeat(401));
  });
});
