// build-client.mjs 的类型声明（rolldown 打包器仅构建期使用）。
// 注意 singleEntryChunk 的声明在 build-host.d.mts 里有一份**手工副本**：两份脚本各自从
// shared 再导出同一个函数、测试也各从自己那份脚本导入，所以两处签名必须逐字一致，改这里
// 就要同步改那一份（没有自动共享声明的地方）。
export declare function buildClient(): Promise<string>;

/** 本包 client bundle 的 external 清单（官方基座 + 本包 dsh.client.external）。
 *  返回只读视图：调用方只消费清单，不许往结果里塞项（合并与去重是这份清单自己的口径）。 */
export declare function clientExternals(): readonly string[];

/** 从包清单读本包声明的 client external；dsh / dsh.client 的形态错误直接抛错。
 *  @param manifest - 包清单；缺省读本仓 package.json
 *  @returns 声明的说明符（原样、不裁剪不排序） */
export declare function declaredClientExternals(manifest?: unknown): string[];

/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。
 *  @param output - 打包器交回的产物条目（字段只读：判定不改写产物）
 *  @param source - 角色说明，只出现在错误消息里
 *  @returns 那唯一一份 chunk 的正文 */
export declare function singleEntryChunk(
  output: readonly {
    readonly type: "chunk" | "asset";
    readonly fileName: string;
    readonly code?: string;
    readonly isEntry?: boolean;
    readonly moduleIds?: readonly string[];
  }[],
  source: string,
): { readonly type: "chunk"; readonly code: string; readonly moduleIds?: readonly string[] };
