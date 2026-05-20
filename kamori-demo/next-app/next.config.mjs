/** @type {import('next').NextConfig} */
export default {
  // The SDK is a local file: dependency with TypeScript source.
  // transpilePackages tells Next.js to compile it (rather than expect pre-built JS).
  transpilePackages: ["@kamori/sdk"],
  webpack(config) {
    // The SDK uses NodeNext module resolution which requires .js extensions in
    // TypeScript imports (e.g. import "./client.js"). Webpack needs this alias
    // to resolve those .js specifiers to the actual .ts source files.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
