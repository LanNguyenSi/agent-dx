import { describe, expect, it } from "vitest";
import { FrictionDb } from "../src/db.js";

function memDb(): FrictionDb {
  return new FrictionDb(":memory:");
}

describe("FrictionDb", () => {
  it("applies all migrations and reports the latest schema version", () => {
    const db = memDb();
    try {
      expect(db.schemaVersion()).toBe(2);
    } finally {
      db.close();
    }
  });

  it("inserts and retrieves a manual friction", () => {
    const db = memDb();
    try {
      const f = db.insertFriction({
        title: "tasks_list overflow",
        description: "149kB blob",
        toolSurface: "mcp:agent-tasks/tasks_list",
        category: "output-overflow",
        severity: "high",
        source: "manual",
      });
      expect(f.id).toBeGreaterThan(0);
      expect(f.status).toBe("open");
      expect(f.title).toBe("tasks_list overflow");
      const fetched = db.getFriction(f.id);
      expect(fetched?.toolSurface).toBe("mcp:agent-tasks/tasks_list");
      expect(fetched?.severity).toBe("high");
    } finally {
      db.close();
    }
  });

  it("lists frictions with combined filters", () => {
    const db = memDb();
    try {
      db.insertFriction({
        title: "a",
        toolSurface: "foo",
        category: "tool-error",
        source: "manual",
      });
      db.insertFriction({
        title: "b",
        toolSurface: "foo",
        category: "workflow-friction",
        source: "scan",
      });
      db.insertFriction({
        title: "c",
        toolSurface: "bar",
        category: "tool-error",
        source: "manual",
      });

      const byTool = db.listFrictions({ tool: "foo" });
      expect(byTool).toHaveLength(2);

      const byToolAndCategory = db.listFrictions({
        tool: "foo",
        category: "tool-error",
      });
      expect(byToolAndCategory).toHaveLength(1);
      expect(byToolAndCategory[0].title).toBe("a");

      const bySource = db.listFrictions({ source: "scan" });
      expect(bySource).toHaveLength(1);
      expect(bySource[0].title).toBe("b");
    } finally {
      db.close();
    }
  });

  it("updates friction status", () => {
    const db = memDb();
    try {
      const f = db.insertFriction({ title: "t", source: "manual" });
      db.updateFrictionStatus(f.id, "filed");
      expect(db.getFriction(f.id)?.status).toBe("filed");
    } finally {
      db.close();
    }
  });

  it("records a task linked to a friction", () => {
    const db = memDb();
    try {
      const f = db.insertFriction({ title: "t", source: "manual" });
      const task = db.insertTask({
        frictionId: f.id,
        sinkName: "markdown-file",
        sinkTarget: "/tmp/x.md",
      });
      expect(task.id).toBeGreaterThan(0);
      expect(task.sinkName).toBe("markdown-file");
      const tasks = db.listTasksForFriction(f.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].sinkTarget).toBe("/tmp/x.md");
    } finally {
      db.close();
    }
  });

  it("tags are stable and deduped", () => {
    const db = memDb();
    try {
      const f = db.insertFriction({ title: "t", source: "manual" });
      db.addTag(f.id, "mcp");
      db.addTag(f.id, "overflow");
      db.addTag(f.id, "mcp");
      expect(db.tagsFor(f.id)).toEqual(["mcp", "overflow"]);
    } finally {
      db.close();
    }
  });

  it("upserts sessions idempotently", () => {
    const db = memDb();
    try {
      db.upsertSession({
        id: "s1",
        startedAt: "2026-05-17T10:00:00Z",
        endedAt: null,
        projectPaths: ["/x"],
        transcriptPath: "/p.jsonl",
        adapter: "claude-code",
      });
      db.upsertSession({
        id: "s1",
        startedAt: "2026-05-17T10:00:00Z",
        endedAt: "2026-05-17T11:00:00Z",
        projectPaths: ["/x", "/y"],
        transcriptPath: "/p.jsonl",
        adapter: "claude-code",
      });
      const s = db.getSession("s1");
      expect(s?.endedAt).toBe("2026-05-17T11:00:00Z");
      expect(s?.projectPaths).toEqual(["/x", "/y"]);
    } finally {
      db.close();
    }
  });
});

describe("FrictionDb.deleteFriction with recurrence references", () => {
  const base = { title: "t", source: "manual" as const };

  it("deletes an unreferenced friction and leaves others untouched", () => {
    const db = memDb();
    try {
      const a = db.insertFriction({ ...base, title: "a" });
      const b = db.insertFriction({ ...base, title: "b" });
      expect(db.deleteFriction(a.id)).toBe(true);
      expect(db.getFriction(a.id)).toBeNull();
      expect(db.getFriction(b.id)?.recurrenceOfId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("clears recurrence_of_id on rows that pointed at the deleted friction", () => {
    const db = memDb();
    try {
      const a = db.insertFriction({ ...base, title: "dup" });
      const b = db.insertFriction({ ...base, title: "dup" });
      expect(b.recurrenceOfId).toBe(a.id);
      expect(db.deleteFriction(a.id)).toBe(true);
      const kept = db.getFriction(b.id);
      expect(kept).not.toBeNull();
      expect(kept?.recurrenceOfId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("handles a chain A <- B <- C when B is deleted", () => {
    const db = memDb();
    try {
      const a = db.insertFriction({ ...base, title: "a" });
      const b = db.insertFriction({
        ...base,
        title: "b",
        recurrenceOfId: a.id,
      });
      const c = db.insertFriction({
        ...base,
        title: "c",
        recurrenceOfId: b.id,
      });
      expect(db.deleteFriction(b.id)).toBe(true);
      expect(db.getFriction(b.id)).toBeNull();
      expect(db.getFriction(a.id)).not.toBeNull();
      expect(db.getFriction(c.id)?.recurrenceOfId).toBeNull();
    } finally {
      db.close();
    }
  });
});
