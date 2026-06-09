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

// Standalone static pages served at the site root.
const STATIC_FILES = [
  "index.html",
  "admin.html",
  "demo.html",
  "canvass-pro.html",
  "youtility-crm.html",
  "player-highlight.html",
  "solar-analysis.html",
  "sigenstor_home.html",
];

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

  // Copy the standalone HTML pages.
  for (const f of STATIC_FILES) {
    const src = join(root, f);
    if (await exists(src)) {
      await cp(src, join(publicDir, f));
    } else {
      console.warn(`assemble: skipping missing ${f}`);
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
