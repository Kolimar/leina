// Unit tests for memory save use-cases using MockMemoryRepository — zero real SQLite.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockMemoryRepository } from "../mocks/memory.ts";

test("save: creates observation with correct title and content", () => {
  const repo = new MockMemoryRepository();
  const { observation, evolved } = repo.save({
    title: "Architecture decision",
    content: "Use hexagonal architecture",
    type: "architecture",
    scope: "project",
  });

  assert.equal(observation.title, "Architecture decision");
  assert.equal(observation.content, "Use hexagonal architecture");
  assert.equal(observation.type, "architecture");
  assert.equal(evolved, false);
});

test("saveBatch atomic: all items saved in one batch", () => {
  const repo = new MockMemoryRepository();
  const items = [
    { title: "A", content: "a", type: "architecture" as const },
    { title: "B", content: "b", type: "architecture" as const },
    { title: "C", content: "c", type: "architecture" as const },
  ];

  const results = repo.saveBatch(items, { atomic: true });
  assert.equal(results.length, 3);
  for (const r of results) {
    assert.equal(r.ok, true);
  }
  assert.equal(repo.observations.length, 3);
});

test("saveBatch non-atomic: each item saved independently", () => {
  const repo = new MockMemoryRepository();
  const items = [
    { title: "X", content: "x", type: "architecture" as const },
    { title: "Y", content: "y", type: "architecture" as const },
  ];

  const results = repo.saveBatch(items);
  assert.equal(results.length, 2);
  assert.equal(repo.observations.length, 2);
});

test("get: retrieves saved observation by id", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Test",
    content: "data",
    type: "architecture",
  });

  const found = repo.get(observation.id);
  assert.ok(found);
  assert.equal(found.title, "Test");
});

test("get: tolerates leading # prefix", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Hash test",
    content: "content",
    type: "architecture",
  });

  const found = repo.get(`#${observation.id}`);
  assert.ok(found);
  assert.equal(found.title, "Hash test");
});

test("update: modifies title and content in place", () => {
  const repo = new MockMemoryRepository();
  const { observation } = repo.save({
    title: "Original",
    content: "original content",
    type: "architecture",
  });

  const updated = repo.update(observation.id, {
    title: "Updated",
    content: "updated content",
  });

  assert.equal(updated.title, "Updated");
  assert.equal(updated.content, "updated content");
});

test("search: finds observations by title content", () => {
  const repo = new MockMemoryRepository();
  repo.save({ title: "hexagonal arch", content: "ports", type: "architecture" });
  repo.save({ title: "memory model", content: "sqlite", type: "architecture" });

  const hits = repo.search("hexagonal");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.title, "hexagonal arch");
});

test("startSession + saveSession: lifecycle works", () => {
  const repo = new MockMemoryRepository();
  const session = repo.startSession("Dev session");
  assert.ok(session.id);
  assert.equal(session.title, "Dev session");

  const saved = repo.saveSession("Completed migration", { sessionId: session.id });
  assert.equal(saved.summary, "Completed migration");
});
