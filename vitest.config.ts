import { definePackageConfig } from "@jayyuen66/dsh-plugin-shared/config/vitest.base";

// 公共面（test.include / environment / testTimeout / provider / exclude / reporter /
// reportsDirectory / 四项 100% 阈值）在 shared/config/vitest.base.ts 单源；这里只留本包差异。
//
// 统计面里 src 只收 ui-messages.ts：client 半三份源文件都被 client 用例直接 import，
// 但 client-entry.ts（渲染错误分支、宿主网关断连）与 rules-reader.ts（Typert 网关的
// 传输面）在无 DOM、无真网关的测试架上只能被**部分**驱动，四项 100% 的全局阈值收不下
// 它们；vitest 的 glob 阈值是全局聚合之外的**追加**判定（全局聚合仍按 100% 查全部
// include 面），所以要收这两个文件就必须降全局阈值——那是 shared 基线，属 Must-ask，
// 这里不做。排除是明示的取舍：要收进来，先补出能在无 DOM 环境驱动那些分支的测试，
// 再把文件加进这个名单。
export default definePackageConfig({
  coverageInclude: ["host.ts", "lib/**/*.ts", "src/ui-messages.ts"],
  test: {
    setupFiles: ["test/setup-logs.ts"],
  },
});
