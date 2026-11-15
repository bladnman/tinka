import test from "node:test";
import assert from "node:assert/strict";
import { buildBoardNotes } from "../public/board-notes-export.js";

test("buildBoardNotes orders text top-to-bottom then left-to-right", () => {
  const snapshot = {
    title: "Plan  board",
    ownerItemId: "owner",
    items: {
      owner: { id: "owner", title: "Owner doc" },
      a: { id: "a", title: "Spec [draft]", content: { kind: "markdown", url: "https://x.test/spec" } },
      b: { id: "b", title: "Sketch" },
      gone: { id: "gone", title: "Deleted", deletedAt: 1 },
    },
    placements: [
      { id: "p0", itemId: "owner", x: 0, y: 0 },
      { id: "pa", itemId: "a", x: 300, y: 100 },
      { id: "pb", itemId: "b", x: 10, y: 100 },
      { id: "pg", itemId: "gone", x: 0, y: 5 },
      { id: "pr", itemId: "b", x: 0, y: 1, removedAt: 1 },
    ],
    decorations: [
      { id: "d1", type: "sticky", x: 50, y: 400, text: "Later\nidea" },
      { id: "d2", type: "text", x: 900, y: 20, text: "Header" },
      { id: "d3", type: "shape", shape: "diamond", x: 5, y: 20, text: "Decide" },
      { id: "d4", type: "text", x: 0, y: 0, text: "   " },
    ],
  };
  assert.equal(buildBoardNotes(snapshot, { itemLink: (p) => (p.id === "pb" ? "/boards/x/?item=pb" : null) }),
    "# Plan board\n\n- Decide\n- Header\n- [Sketch](/boards/x/?item=pb)\n- [Spec \\[draft\\]](https://x.test/spec)\n- Later idea\n");
});

test("buildBoardNotes handles an empty snapshot", () => {
  assert.equal(buildBoardNotes({}), "# Untitled board\n");
});
