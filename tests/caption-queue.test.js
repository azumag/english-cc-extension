import test from "node:test";
import assert from "node:assert/strict";
import { CaptionQueue, findPreferredBreak, segmentSourceText } from "../src/captions/caption-queue.js";

// findPreferredBreak() is also reused directly by
// src/speech/interim-committer.js (see docs/HANDOFF.md 9.10); pin its
// behavior here since it's now a public export, not just an implementation
// detail of segmentSourceText().
test("findPreferredBreak() prefers a sentence boundary over an earlier soft boundary", () => {
  // "、" (soft) sits at index 3, "。" (sentence) at index 8 — the sentence
  // boundary wins even though it comes later in the scanned window.
  assert.equal(findPreferredBreak("今日は、晴れです。おまけ", 12), 9);
});

test("findPreferredBreak() takes a soft boundary only at or past 60% of maxChars", () => {
  // A comma at index 2 is well before 60% of 10 -> ignored in favor of the hard cut.
  assert.equal(findPreferredBreak("a,bcdefghij", 10), 10);
  // A comma at index 6 (>= 60% of 10) is taken.
  assert.equal(findPreferredBreak("abcdef,ghij", 10), 7);
});

test("findPreferredBreak() hard-cuts at maxChars when no boundary exists in range", () => {
  assert.equal(findPreferredBreak("abcdefghijklmnop", 10), 10);
});

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

test("segments long source text at sentence boundaries before processing", async () => {
  assert.deepEqual(segmentSourceText("今日は晴れです。明日は雨です。", 8), ["今日は晴れです。", "明日は雨です。"]);

  const processed = [];
  const metadata = [];
  const queue = new CaptionQueue({
    sourceChunkChars: 8,
    maxPending: 1,
    processor: async (item) => {
      processed.push(item.text);
      metadata.push([item.segmentIndex, item.segmentCount]);
    },
  });

  queue.submit({ text: "今日は晴れです。明日は雨です。" });
  await queue.whenIdle();

  assert.deepEqual(processed, ["今日は晴れです。", "明日は雨です。"]);
  assert.deepEqual(metadata, [[0, 2], [1, 2]]);
});

test("hard-splits a long source phrase when no natural boundary exists", () => {
  assert.deepEqual(segmentSourceText("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
});
