// build-client.mjs 的类型声明（rolldown 打包器仅构建期使用）。
export declare function buildClient(): Promise<string>;

/** 本包 client bundle 的 external 清单（官方基座 + 本包 dsh.client.external）。 */
export declare function clientExternals(): string[];
