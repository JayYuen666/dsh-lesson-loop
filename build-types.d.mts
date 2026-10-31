// build-types.mjs 的声明（供 test/publish-manifest.test.ts、test/build-types.test.ts 与
// test/build-declarations.test.ts 从 TS 侧类型化导入）。声明范围＝测试与主流程真正调用的面：
// 列 types/ 下的声明文件、产出 types/ 的入口、那条会跑子进程的命令助手。
// canonicalizeDeclarationSpecifiers 仍是 shared 的导出、但本脚本不再转手，故不在此声明——
// 多写一份没人用的签名只会让它与实现悄悄分叉。
/**
 * 递归列出目录下的 .d.ts 文件。
 * @param dir - 当前目录绝对路径
 * @param prefix - 相对包根前缀
 * @returns 命中的文件清单，相对包根、/ 分隔
 */
export function listDeclarations(dir: string, prefix: string): Promise<string[]>;

/**
 * 从一份包清单解析 tsc 入口；读取、解析与入口校验的失败都带上清单路径。
 * @param pkgPath - 包清单绝对路径
 * @returns tsc 入口绝对路径
 */
export function tscEntryFromManifest(pkgPath: string): string;

/**
 * 产出 types/：跑 tsc 出声明，再逐个改写相对说明符。
 * @returns 写出的声明文件清单（相对包根、/ 分隔）
 */
export function buildTypes(): Promise<string[]>;

/**
 * 跑一条命令（cwd 钉在包根）；失败时抛出带子进程 stdout 与 stderr 的错误。
 * @param file - 可执行文件
 * @param args - 参数
 * @returns 无返回值——同步语义是契约的一部分，调用方不该拿它当 Promise
 */
export function runCommand(file: string, args: string[]): void;
