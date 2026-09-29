import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@abw/shared"],
  webpack: (config) => {
    // @abw/shared is NodeNext ESM source: its imports say "./qa.js" but the
    // files are .ts — let webpack resolve the TypeScript source
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
