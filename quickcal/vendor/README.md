# Vendored libraries

Everything the page loads lives in this repo. Nothing is fetched from a CDN.

## chrono-node 2.10.1 (English locale only)

- Source: https://registry.npmjs.org/chrono-node/-/chrono-node-2.10.1.tgz
- Tarball sha512 (npm `dist.integrity`):
  `sha512-tPOsBzYVAK5zth+CiHCgp5NGeqRc4mMD8FPthQ5IxkgjPWWxIFdM5odnmfw//IRAzl6C++Xy8olQW7wn5qBR1g==`
- License: MIT (see `LICENSE-chrono-node.txt`)
- File here: `chrono-en.min.js`, exposes `window.chrono`

chrono-node ships only ES modules, so it was bundled once into a single
classic script. This was done on 2026-09-09 and the output committed. It is
not a build step for the app; you only redo it to upgrade the library.

To reproduce or upgrade (run in any empty folder, then copy the output here):

```sh
npm init -y
npm install esbuild@0.25.9 chrono-node@2.10.1
printf 'export * from "chrono-node/en";\n' > entry.js
npx esbuild entry.js --bundle --format=iife --global-name=chrono --minify \
  --target=safari15 --outfile=chrono-en.min.js \
  --banner:js="/* chrono-node 2.10.1 (English locale only) - MIT License - https://github.com/wanasit/chrono - bundled with esbuild 0.25.9 */"
```

If you upgrade, change the version in this file, in the banner, and in
CLAUDE.md, and re-run `node tests/parse.test.js`.
