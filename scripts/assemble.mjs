// Assemble the Firebase Hosting `public/` directory:
//   - static HTML tools + landing + admin console at the root
//   - the built React field app (canvasspro-web/dist) under /app
//
// Run after `canvasspro-web` has been built (see root package.json `build`).
import { rm, mkdir, cp, readdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");
const appDist = join(root, "canvasspro-web", "dist");

// Deny-list model: EVERY root-level *.html page is published by default, so a
// new tool/page goes live automatically (and you can never forget to add it to
// a list). To keep a page OUT of the live site, add its filename here.
const SKIP = new Set([
  "youtilityknock-home.html", // superseded by index.html; not referenced anywhere
]);

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await rm(publicDir, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true });

  // Copy every root-level static HTML page except those on the SKIP list.
  const entries = await readdir(root, { withFileTypes: true });
  const pages = entries
    .filter((e) => e.isFile() && e.name.endsWith(".html") && !SKIP.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const f of pages) {
    await cp(join(root, f), join(publicDir, f));
  }
  console.log(`assemble: ${pages.length} HTML pages → ${pages.join(", ")}`);
  if (SKIP.size) console.log(`assemble: skipped (not published) → ${[...SKIP].join(", ")}`);

  // Copy static media folders (promo videos, posters) served at the root.
  for (const dir of ["promo-media"]) {
    if (await exists(join(root, dir))) {
      await cp(join(root, dir), join(publicDir, dir), { recursive: true });
      console.log(`assemble: copied ${dir}/ → public/${dir}/`);
    }
  }

  // Copy the built React app under /app.
  if (!(await exists(appDist))) {
    throw new Error(
      `assemble: ${appDist} not found — run the React build first (npm run build:app).`
    );
  }
  await cp(appDist, join(publicDir, "app"), { recursive: true });

  const out = await readdir(publicDir);
  console.log(`assemble: public/ ready → ${out.join(", ")}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
