# Aurora

Aurora 是一组 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件的集合仓库。
每个插件是一个独立的 npm 包，放在 `packages/` 下，可以单独安装、启用、卸载。

| 插件 | 作用 |
| --- | --- |
| [`aurora-system-stats`](packages/aurora-system-stats/README.md) | 网页悬浮球：实时展示 CPU、内存、磁盘占用与系统 load，点开是完整的面板 |

## 目录结构

```
aurora/
├── package.json              # 工作区脚本（build / dev / typecheck / link / unlink）
├── pnpm-workspace.yaml       # packages/* 就是一个工作区
├── scripts/
│   ├── build.mjs             # 单包构建：host（Node ESM）+ client（浏览器 bundle）
│   ├── each.mjs              # 对所有包按依赖顺序跑一个脚本，不依赖 pnpm
│   ├── link-profile.sh       # 把包链接进一个 dsh profile
│   └── unlink-profile.sh     # 从 profile 移除
└── packages/
    └── aurora-system-stats/
        ├── src/host/         # 宿主半侧：读取 /proc，注册 /api 路由
        ├── src/client/       # 浏览器半侧：悬浮球与面板（React，无 JSX 依赖）
        ├── cordis.patch.yml  # bundle 层：把插件那一行插进 profile
        └── lib/              # 构建产物（已 gitignore）
```

## 开发

```bash
pnpm install          # 或 npm install（npm 需要写一下本地 cache，见下）
pnpm build            # 构建所有包：lib/index.js + lib/client.js
pnpm dev              # 监听 src/，改动即重建
pnpm typecheck        # tsc --noEmit
```

`pnpm` 不可用时，工作区脚本本身不依赖它：

```bash
npm install --cache .npm-cache   # 该机器的全局 npm cache 属于 root，换个目录即可
node scripts/each.mjs build
```

## 装到正在运行的 dsh 里

```bash
pnpm build
bash scripts/link-profile.sh web        # 默认 profile 取 $DSH_PROFILE，其次 web
```

脚本执行的是官方接口 `dsh plugin --profile web add --save-prod file:<包目录>`，
会同时把依赖写进 profile 的 `package.json` 并加入 `dsh.profile.bundles`。
装完后到 **设置 → 插件** 里确认插件是打开的；插件加载后刷新一次页面即可看到悬浮球。

改动代码后重新 `pnpm build`，再跑一次 `link-profile.sh`：pnpm 会把 `file:` 依赖按
`files` 白名单复制进 profile，重新 link 才会带上新产物。

## 写一个新插件

1. 复制 `packages/aurora-system-stats` 作为模板（`package.json` 里改 `name`/`description`），
   并把内部模块名改成新包名。
2. `src/host/index.ts` 导出 `name`、`inject`、`apply(ctx)`；需要浏览器访问的数据在这里注册路由。
3. `src/client/index.ts` 导出同样的三样东西，用 `module.exports` 发布插件面
   （浏览器 bundle 以经典脚本执行，factory 返回的就是 `module.exports`）。
4. `node scripts/each.mjs build`，再 `bash scripts/link-profile.sh web <包名>`。

浏览器半侧只能从 dsh 的共享模块表里 `require`：`react`、`react/jsx-runtime`、
`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`。构建脚本会检查这一点，
出现别的裸导入会直接失败。

## License

MIT
