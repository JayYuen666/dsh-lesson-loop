// build-client.mjs 的类型声明（rolldown 打包器仅构建期使用）。
export declare function buildClient(): Promise<string>;

/** 本包 client bundle 的 external 清单（官方基座 + 本包 dsh.client.external）。 */
export declare function clientExternals(): string[];
/** 单文件产物只接受唯一的 entry chunk；多余 chunk / asset 直接构建失败。 */
export declare function singleEntryChunk(
  output: readonly {
    type: string;
    fileName: string;
    code?: string;
    isEntry?: boolean;
    moduleIds?: string[];
  }[],
  source: string,
): { type: "chunk"; code: string; moduleIds?: string[] };
