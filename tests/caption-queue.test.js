import test from "node:test";
import assert from "node:assert/strict";
import { CaptionQueue } from "../src/captions/caption-queue.js";

test("processes captions in FIFO order", async () => {
  const processed = [];
  const queue = new CaptionQueue({ processor: async (item) => processed.push(item.text) });
  queue.submit({ text: "first" });
  queue.submit({ text: "second" });
  await queue.whenIdle();
  assert.deepEqual(processed, ["first", "second"]);
});

test("drops the oldest pending caption when full", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const processed = [];
  const dropped = [];
  const queue = new CaptionQueue({
    maxPending: 2,
    processor: async (item) => {
      processed.push(item.text);
      if (item.text === "active") await gate;
    },
    onDrop: (item, reason) => dropped.push([item.text, reason]),
  });

  queue.submit({ text: "active" });
  await new Promise((resolve) => setImmediate(resolve));
  queue.submit({ text: "old" });
  queue.submit({ text: "newer" });
  queue.submit({ text: "newest" });
  release();
  await queue.whenIdle();

  assert.deepEqual(dropped, [["old", "overflow"]]);
  assert.deepEqual(processed, ["active", "newer", "newest"]);
});

test("drops expired captions before processing", async () => {
  let now = 10_000;
  const dropped = [];
  const queue = new CaptionQueue({
    maxAgeMs: 1000,
    clock: () => now,
    processor: async () => assert.fail("expired caption should not be processed"),
    onDrop: (_item, reason) => dropped.push(reason),
  });
  queue.submit({ text: "expired", createdAt: 0 });
  await queue.whenIdle();
  assert.deepEqual(dropped, ["expired"]);
});
