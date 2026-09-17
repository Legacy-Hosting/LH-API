import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

test("migrations are sequential and avoid destructive database operations", async () => {
  const directory = resolve(process.cwd(), "database", "migrations");
  const files = (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0);
  const numbers = files.map((file) => Number(file.slice(0, 3)));
  assert.deepEqual(
    numbers,
    Array.from({ length: numbers.length }, (_, index) => index + 1),
  );
  for (const file of files) {
    const sql = await readFile(resolve(directory, file), "utf8");
    assert.doesNotMatch(
      sql,
      /\bDROP\s+(?:DATABASE|TABLE)\b/i,
      `${file} contains a destructive DROP`,
    );
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `${file} contains TRUNCATE`);
  }
});
