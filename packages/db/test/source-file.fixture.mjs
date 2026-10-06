import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../src/", import.meta.url);
export const sourceText = file => readFileSync(new URL(file, root), "utf8");
export const sourceFiles = () => readdirSync(root);
