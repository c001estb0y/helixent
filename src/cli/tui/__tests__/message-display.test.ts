import { describe, expect, test } from "bun:test";

import { nextStaticMessageCount } from "../message-display";

describe("nextStaticMessageCount", () => {
  test("does not stream each new in-flight message into static output", () => {
    expect(
      nextStaticMessageCount({
        messagesLength: 3,
        previousStaticMessageCount: 0,
        streaming: true,
      }),
    ).toBe(0);
  });

  test("advances to all but the last message after streaming completes", () => {
    expect(
      nextStaticMessageCount({
        messagesLength: 4,
        previousStaticMessageCount: 0,
        streaming: false,
      }),
    ).toBe(3);
  });

  test("keeps previously flushed messages static during a later run", () => {
    expect(
      nextStaticMessageCount({
        messagesLength: 6,
        previousStaticMessageCount: 3,
        streaming: true,
      }),
    ).toBe(3);
  });

  test("resets when the transcript is cleared", () => {
    expect(
      nextStaticMessageCount({
        messagesLength: 0,
        previousStaticMessageCount: 3,
        streaming: false,
      }),
    ).toBe(0);
  });
});
