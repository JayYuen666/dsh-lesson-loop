import {
  READONLY_SYNC_ALLOWLIST,
  definePluginConfig,
} from "@jayyuen66/dsh-plugin-shared/config/oxlint";
import type { OxlintOverride } from "oxlint";

/** 生产代码真实调用点（node/no-sync 的写侧例外，谁用谁声明）：
 *  appendFileSync / writeFileSync / renameSync / rmSync → lib/jsonl-fuse.ts
 *  （锁文件的写入与原子替换、裁尾临时文件落盘、陈旧锁接管后的清理）；
 *  mkdirSync → lib/lesson-jsonl.ts（流水文件落盘前补建目录）。 */
const PROD_SYNC_WRITES: string[] = [
  "appendFileSync",
  "mkdirSync",
  "renameSync",
  "rmSync",
  "writeFileSync",
];

/** 仅测试用：用例在临时目录里造夹具（mkdtempSync）、把锁文件 mtime 做旧驱动
 *  「陈旧锁接管」分支（utimesSync）。生产代码不豁免——lib/、src/、host.ts 再出现
 *  这两个调用会被 lint 拦下。 */
const TEST_ONLY_SYNC_WRITES: string[] = ["mkdtempSync", "utimesSync"];

/** test/ 的覆盖规则整体替换基线那条 node/no-sync，故只读白名单必须一起带上，
 *  否则用例里的 readFileSync/statSync 一类会跟着红。 */
const TEST_SYNC_OVERRIDE: OxlintOverride = {
  files: ["test/**"],
  rules: {
    "node/no-sync": [
      "error",
      {
        ignores: [...READONLY_SYNC_ALLOWLIST, ...PROD_SYNC_WRITES, ...TEST_ONLY_SYNC_WRITES],
      },
    ],
  },
};

export default definePluginConfig({
  syncWrites: PROD_SYNC_WRITES,
  extraOverrides: [TEST_SYNC_OVERRIDE],
  titlePrefixes: ["Config", "DSH_HOME", "JSONL", "PLUGIN_NAME"],
});
