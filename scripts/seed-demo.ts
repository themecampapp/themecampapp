// SPDX-FileCopyrightText: 2026 Curtis Kline and contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// Resets the public demo camp (R67) to fresh fictional data: `demo.<domain>`. Safe to re-run;
// it refuses to touch a camp that isn't a demo. Uses the owner DATABASE_URL.
//   DATABASE_URL=… npm run demo:seed [-- --slug demo --name "Mirage Camp"]
// With --bucket, it also uploads the demo's files (avatars, a sample SAP pass) to that R2
// bucket through Wrangler (logged in), and points the camp at them:
//   DATABASE_URL=… npm run demo:seed -- --bucket tca-files-staging
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { resetDemoCamp } from "./lib/demo-data";
import { demoFiles } from "./lib/demo-files";

const { values } = parseArgs({
  options: { slug: { type: "string" }, name: { type: "string" }, bucket: { type: "string" } },
});
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (owner) is required");
  process.exit(1);
}
if (values.bucket && !/^tca-files(-staging)?$/.test(values.bucket)) {
  console.error("--bucket must be tca-files or tca-files-staging");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const id = await resetDemoCamp(sql, {
    slug: values.slug,
    name: values.name,
    withFiles: !!values.bucket,
  });
  console.log(`Demo camp ${values.slug ?? "demo"} reset (${id}).`);
  if (values.bucket) {
    const dir = mkdtempSync(join(tmpdir(), "demo-files-"));
    try {
      const files = await demoFiles(id);
      for (const [n, f] of files.entries()) {
        const path = join(dir, `${n}`);
        writeFileSync(path, f.bytes);
        execFileSync(
          "npx",
          [
            "wrangler",
            "r2",
            "object",
            "put",
            `${values.bucket}/${f.key}`,
            "--file",
            path,
            "--content-type",
            f.contentType,
            "--remote",
          ],
          { stdio: "ignore" },
        );
        process.stdout.write(`\rUploaded ${n + 1} of ${files.length} files`);
      }
      process.stdout.write("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
