// build-host.mjs 的类型声明（rolldown 打包器仅构建期使用，产物 host.js 供 dsh 载入）。
// singleEntryChunk 的声明在 build-client.d.mts 里有一份**手工副本**：两份脚本各自从 shared
// 再导出同一个函数、测试也各从自己那份脚本导入，两处签名必须逐字一致，改一处要同步另一处。
/** 生成 host.js 的完整文本（不写盘：写盘与写盘前自检在脚本的 main() 里）。 */
export declare function buildHost(): Promise<string>;

/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。
 *  @param output - 打包器交回的产物条目（字段只读：判定不改写产物）
 *  @param source - 角色说明，只出现在错误消息里
 *  @returns 那唯一一份 chunk 的正文；不是恰好一份 entry chunk 时抛错 */
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
