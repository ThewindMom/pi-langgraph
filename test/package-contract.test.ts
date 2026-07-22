import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("package metadata declares the verified extension host contract", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(packageJson.peerDependencies?.typebox).toBe("^1.1.38");
  expect(packageJson.packageManager).toBe("bun@1.3.14");
  expect(packageJson.files).toContain("src");
  expect(packageJson.pi?.extensions).toEqual(["./src/index.ts"]);
});
