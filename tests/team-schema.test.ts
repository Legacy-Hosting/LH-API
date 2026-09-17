import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTeamBody,
  createTeamSlug,
} from "../src/shared/modules/teams/team.routes.js";

test("team creation accepts a trimmed name", () => {
  const result = createTeamBody.safeParse({ name: "  Legacy Hosting  " });

  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.name, "Legacy Hosting");
});

test("team slugs are URL-safe and stay inside the database limit", () => {
  const slug = createTeamSlug(
    "Legacy Hosting – A very long customer workspace name that exceeds the normal slug length",
    "1234abcd",
  );

  assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*-1234abcd$/);
  assert.ok(slug.length <= 80);
});
