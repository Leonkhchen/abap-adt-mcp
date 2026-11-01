/**
 * version.ts — 版本號唯一來源:package.json
 *
 * 以 createRequire 在執行期讀取(src/ 與 dist/ 都位於專案根目錄下一層,
 * 因此 ../package.json 皆指向同一份),避免 tsc rootDir 限制與版本號散落各處。
 */
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

export const VERSION: string = pkg.version;
