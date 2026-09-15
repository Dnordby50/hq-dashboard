import { readFile, readdir, lstat, mkdir, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('./public-assets.json', import.meta.url), 'utf8'));
const generatedAsset = /^estimator\/(?:index\.html|manifest\.webmanifest|registerSW\.js|sw\.js|workbox-[\w-]+\.js|pwa-icon\.svg|assets\/[\w.-]+\.(?:js|css|svg|png|webp|woff2?))$/;
export function allowedPublicPath(path) {
  return manifest.files.includes(path) || generatedAsset.test(path);
}

async function walk(root, path) {
  const info = await lstat(resolve(root, path));
  if (info.isSymbolicLink()) throw new Error(`Public assets must not be symbolic links: ${path}`);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) throw new Error(`Unsupported public asset: ${path}`);
  const files = [];
  for (const item of await readdir(resolve(root, path))) files.push(...await walk(root, `${path}/${item}`));
  return files;
}

export async function buildPublicSite(root = projectRoot) {
  const output = resolve(root, 'dist');
  const paths = [...manifest.files, ...await walk(root, 'estimator')];
  // Validate the whole artifact before replacing the previous build.
  for (const path of paths) {
    if (!allowedPublicPath(path) || relative(root, resolve(root, path)).startsWith(`..${sep}`)) {
      throw new Error(`File is not approved for publication: ${path}`);
    }
    if (!(await lstat(resolve(root, path))).isFile()) throw new Error(`Expected a regular public file: ${path}`);
  }
  await rm(output, { recursive: true, force: true });
  for (const path of paths) {
    const target = resolve(output, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(root, path), target);
  }
  console.log(`Public site built: ${paths.length} approved files. Internal source and documents excluded.`);
  return paths;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildPublicSite();
