import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: ["./db/schema.ts", "./db/reader-cabinet-schema.ts"],
  dialect: "sqlite",
});
