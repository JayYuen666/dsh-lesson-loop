// build-types.mjs 的声明（供 test/publish-manifest.test.ts 与 test/build-types.test.ts 从 TS 侧
// 类型化导入）。只声明测试真正调用的那一面：列 types/ 下的声明文件、以及那条会跑子进程的
// 命令助手。canonicalizeDeclarationSpecifiers 同为导出但测试不直接调它，故不在此声明——
// 多写一份没人用的签名只会让它与实现悄悄分叉。
/**
 * 递归列出目录下的 `.d.ts` 文件。
 *
 * @param dir - 当前目录绝对路径
 * @param prefix - 相对包根前缀
 * @returns 命中的文件清单，相对包根、`/` 分隔
 */
export function listDeclarations(dir: string, prefix: string): Promise<string[]>;

/**
 * 跑一条命令；失败时抛出带子进程 stdout 与 stderr 的错误。
 *
 * @param file - 可执行文件
 * @param args - 参数
 * @returns 无返回值（成功即返回）
 */
export function runCommand(file: string, args: string[]): void;
