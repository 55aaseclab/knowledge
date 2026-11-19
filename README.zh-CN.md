# Knowledge

[English](README.md)

浏览工作空间中的文库，阅读文档和笔记、检索索引段落并查看会议论文统计。运行时支持带版本的条目、附件收件箱、文档解析及按权限受限的业务操作，新安装默认为空。

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4324
```

## Praxis 集成

应用维护的[供数合同](docs/PRAXIS-PROVIDER.md)提供按授权过滤、有来源依据的卡片与数据源描述，不增加 HTTP 元数据入口。使用 `npm run test:provider` 验证隔离供数测试。
