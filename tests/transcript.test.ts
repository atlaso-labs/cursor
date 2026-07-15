import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchangeFromPayload, lastExchangeFromFile } from "../lib/transcript";

const tmp = mkdtempSync(join(tmpdir(), "atlaso-tx-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("exchangeFromPayload", () => {
  test("documented fields: prompt + text", () => {
    expect(exchangeFromPayload({ prompt: "yo", text: "hi" })).toEqual(["yo", "hi"]);
  });
  test("user_message fallback", () => {
    expect(exchangeFromPayload({ user_message: "u" })).toEqual(["u", ""]);
  });
  test("empty payload", () => {
    expect(exchangeFromPayload({})).toEqual(["", ""]);
  });
});

describe("lastExchangeFromFile", () => {
  test("missing / empty path → ['','']", () => {
    expect(lastExchangeFromFile("")).toEqual(["", ""]);
    expect(lastExchangeFromFile(join(tmp, "nope.jsonl"))).toEqual(["", ""]);
  });
  test("JSONL: takes the last user + the assistant reply after it", () => {
    const p = join(tmp, "t.jsonl");
    writeFileSync(
      p,
      [
        JSON.stringify({ role: "user", content: "first" }),
        JSON.stringify({ role: "assistant", content: "ignored old reply" }),
        JSON.stringify({ role: "user", content: "always use pnpm" }),
        JSON.stringify({ role: "assistant", content: "got it" }),
      ].join("\n"),
    );
    expect(lastExchangeFromFile(p)).toEqual(["always use pnpm", "got it"]);
  });
  test("single JSON doc with a messages array + typed content blocks", () => {
    const p = join(tmp, "doc.json");
    writeFileSync(
      p,
      JSON.stringify({
        messages: [
          { author: "human", content: [{ type: "text", text: "hello there" }] },
          { author: "model", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    );
    expect(lastExchangeFromFile(p)).toEqual(["hello there", "hi"]);
  });
});
