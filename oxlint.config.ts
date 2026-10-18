import { definePluginConfig } from "@jayyuen66/dsh-plugin-shared/config/oxlint";

export default definePluginConfig({
  // 本包真实用到的同步写盘 API —— node/no-sync 的包内例外。
  // 基线只放只读那一组（写盘类谁用谁声明），所以这一条是可独立 review 的声明而不是全局豁免表。
  //   renameSync  —— lib/jsonl-fuse.ts 的原子替换（`.tmp` → 目标文件，读者不会读到写了一半的中间态）；
  //   utimesSync  —— 仅测试：把锁文件 mtime 做旧，驱动"陈旧锁接管"那条分支（生产的锁龄判据在 jsonl-fuse）。
  syncWrites: [
    "appendFileSync",
    "mkdirSync",
    "mkdtempSync",
    "renameSync",
    "rmSync",
    "utimesSync",
    "writeFileSync",
  ],
  titlePrefixes: ["Config", "DSH_HOME", "JSONL", "PLUGIN_NAME"],
});
