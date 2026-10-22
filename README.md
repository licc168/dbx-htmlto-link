# HTML To Link · DBX 插件

在 DBX 里点一下，把当前查询结果，或一张表的字段定义，发成一条只读的 [htmlto.link](https://htmlto.link) 链接。

数据库地址、账号和密码留在 DBX。查询结果只上传网格里的行。表结构上传字段名、类型、是否可空、长度或精度、默认值，并在 MySQL、PostgreSQL、SQL Server 上再读取索引（含主键）、外键和注释（表注释、字段注释）。页面上的语句是按这些信息拼出来的，不是数据库里的原始 DDL。第一次读目录时，DBX 会弹出「数据访问请求」，点允许后这个连接会记住，直到在插件中心撤销。可选访问密码。不填 API Token 时，页面大约保留 24 小时；填写 [htmlto.link/settings](https://htmlto.link/settings) 里的 Token 后，页面归到账号，有效期跟随账号。

## 在 DBX 里用

1. 执行一条查询，在结果网格工具栏打开 **发布到 htmlto.link**。
2. 或在左侧表名上右键，选 **发布表结构到 htmlto.link**。面板里可以再勾选同一库的其他表，最多 20 张，合成一个页面。第一次会弹出 DBX 的「数据访问请求」，点「是」。
3. 看预览，选择模板。备忘录、波普艺术、线圈笔记本还可以选主题。需要的话填写访问密码。API Token 可以手贴，也可以点 **获取 Token**：浏览器里已登录会自动填入，未登录会先打开登录页。
4. 查询结果超过 500 行时，可以让插件用同一条只读 SQL 再读，最多 5000 行。DBX 会先请你同意这个连接。
5. 勾选「附带 SQL」后，查询语句会出现在公开页面上。默认不附带。表结构页总会带上拼出来的字段定义；读到索引、外键和注释时会一起写上。没有「附带 SQL」这个勾选。

插件中心也可以打开同一页面，用来保存 Token。没有查询结果、也没有选中表时不能发布。

视图、存储过程和编辑器里选中的 SQL 没有表菜单。要发出一段 DDL 原文，先在 DBX 里执行它，再从结果网格发布，并勾选附带 SQL。

## 安装未签名的开发包

```bash
npx @dbx-app/plugin-cli package .
```

包在 `dist/link.htmlto.query-share-0.2.6-universal.dbxp`。

DBX 里打开插件中心，允许未签名开发包，再安装这个文件。源码在 [licc168/dbx-htmlto-link](https://github.com/licc168/dbx-htmlto-link)，许可证是 MIT。正式上架把这个仓库的 Release 交给 [t8y2/dbx-store](https://github.com/t8y2/dbx-store) 审核签名，不要把插件源码提交到 `t8y2/dbx`。

## 站点要求

插件页面跑在 DBX 沙箱里，发布请求发到 `https://htmlto.link/api/shares`。站点需要允许这个跨域请求。html2url 里已经加上了 `/api/shares` 的 CORS；部署之后，插件才能从 DBX 里发布。

## 开发

```bash
node --test lib/result-markdown.test.mjs
npx @dbx-app/plugin-cli dev --path . --port 5190
```

`dbx-plugin dev` 的沙箱默认不允许外网，真正的发布要在 DBX 里验证。`.dbx-dev/` 和 `dist/` 不要提交。
