设置项、默认值与取值范围见设置卡上的 ⓘ 帮助和随包 README；除三枚重启值外，改完即时生效。

**规则不是设置表格。** 每条规则在自己的卡上单独处置：生效、改写、降级、归档、拒绝、复活；批量开关会让一次回合并改所有规则。已归档/拒绝的卡可「彻底删除」，不可恢复，需连点两次确认。

**要重启的值。** `digestTimeoutMs`、`decayIntervalMs`、`maxInjectedRules` 写在本插件注册行的 `config:` 块，重启生效。

**数据与集成。** 证据由危险命令拦截、质量门禁与会话续跑救援经共享教训总线汇入；规则、流水与台账同住 `$DSH_HOME/data/lesson-loop/lesson-loop.db`。表结构、并发与保留口径见 README。

欢迎提 issue 和 PR：[https://github.com/JayYuen666/dsh-lesson-loop/issues](https://github.com/JayYuen666/dsh-lesson-loop/issues)。
