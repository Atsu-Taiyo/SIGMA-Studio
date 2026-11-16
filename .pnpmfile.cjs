// npm resolved tooling's TypeScript peer through the root's 5.9.3 installation,
// while workspace tsc commands use 7.0.2. pnpm would bind those peers to 7.0.2,
// which typescript-eslint cannot load. Preserve the existing tooling runtime.
module.exports = {
  hooks: {
    readPackage(pkg) {
      const tooling = pkg.name?.startsWith("@typescript-eslint/")
        || ["typescript-eslint", "eslint-config-next", "ts-api-utils"].includes(pkg.name);
      if (tooling && pkg.peerDependencies?.typescript) {
        pkg.dependencies = { ...pkg.dependencies, typescript: "5.9.3" };
        delete pkg.peerDependencies.typescript;
      }
      return pkg;
    },
  },
};
