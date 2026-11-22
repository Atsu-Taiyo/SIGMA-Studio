# SIGMA AI third-party notices

This directory contains the MIT-licensed DeepSeek Harness and the standalone
Node.js runtime. The Node.js license and included notices are in `node/LICENSE`.
Package-specific license files and notices are in the corresponding
`node_modules` directories. The adjacent lockfile identifies the exact sources.

- [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness)
- [Node.js 24.22.3 distribution and source](https://nodejs.org/dist/v24.22.3/)
- [sharp 0.35.5 source](https://github.com/lovell/sharp/tree/v0.35.5)
- [libvips 1.3.4 build scripts, dependencies and notices](https://github.com/lovell/sharp-libvips/tree/v1.3.4)
- [GNU LGPL v3](licenses/LGPL-3.0.txt) and [GNU GPL v3](licenses/GPL-3.0.txt)

The sharp/libvips notices apply to the shared libraries under
`node_modules/@img`. Their package notices and upstream build sources identify
the exact library versions and the instructions to rebuild them. In an unpacked
build the shared libraries are separate files. Replace compatible library files
in a local copy to use a modified build.
