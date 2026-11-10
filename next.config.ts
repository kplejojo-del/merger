import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @libsql/client حزمة Node تُجرَّب خارج حزمة الباندل — ضروري لعمل Turso في serverless
  serverExternalPackages: ["@libsql/client"],
  reactStrictMode: true,
};

export default nextConfig;
