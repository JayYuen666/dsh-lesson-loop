import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

/** lib/jsonl-fuse.ts 的写侧名单：锁的原子占位与无覆盖归位、原子替换、裁尾临时文件落盘、
 *  陈旧锁清理。 */
const FUSE_SYNC_WRITES = [
  "appendFileSync",
  "chmodSync",
  "linkSync",
  "renameSync",
  "rmSync",
  "writeFileSync",
];

export default definePluginConfig({
  // node/no-sync 的写侧例外按文件声明（syncWrites 那枚基线参数生成的是全局作用的 ignores，
  // 等于给 lib/、src/、host.ts 都开了豁免，与「谁用谁声明」不是一回事）。基线只读名单由共享
  // 配置在这一层一起带上，不需要本仓重列 —— override 对同一条规则是整条设置替换。
  syncIoScopes: [
    { files: ["lib/jsonl-fuse.ts"], apis: FUSE_SYNC_WRITES },
    // lib/lesson-jsonl.ts 只用到 mkdirSync（目录补建）；appendFileSync 已收进 fuse 层。
    { files: ["lib/lesson-jsonl.ts"], apis: ["mkdirSync"] },
    // 仅测试用：用例在临时目录里造夹具（mkdtempSync）、把锁文件 mtime 做旧驱动
    // 「陈旧锁接管」分支（utimesSync）、门禁的源码收集按 lstatSync 跳过软链。
    // 生产代码不豁免 —— lib/、src/、host.ts 再出现这些调用会被 lint 拦下。
    {
      files: ["test/**"],
      apis: [...FUSE_SYNC_WRITES, "mkdirSync", "lstatSync", "mkdtempSync", "utimesSync"],
    },
  ],
  // prefer-lowercase-title 的免检**用例标题**前缀（基线 allowedPrefixes 口径）：本仓
  // 实际用到的是 test/host.test.ts 里以 Config 开头的用例标题；DSH_HOME / JSONL /
  // PLUGIN_NAME 是同一批技术名起点（卡片文案走 UI 字面量，不受这条规则管）。
  // 前缀是字面量前缀匹配，`Config` 会连带放行 `Configuration` 一类普通标题——新增
  // 前缀先问"它是不是技术名起点"。
  titlePrefixes: ["Config", "DSH_HOME", "JSONL", "PLUGIN_NAME"],
});
