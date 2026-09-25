import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/index.js";

test("add(1, 2) === 3", () => {
  assert.equal(add(1, 2), 3);
});

test("add('1', 2) === 3（数字字符串需按数字处理）", () => {
  assert.equal(add("1", 2), 3);
});
