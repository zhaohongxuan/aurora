# AGENTS.md

Aurora 是 **dsh（DeepSeek Harness）插件集合**，工作区用 `packages/*` 组织，每个包都能单独安装。
本文件面向在这个仓库里干活的 agent / 人：先读这里，再去读具体包的 README。

## 命令

```bash
node scripts/each.mjs build       # 构建所有包（不依赖 pnpm）
node scripts/each.mjs typecheck   # tsc --noEmit
node scripts/each.mjs dev         # 监听 src/，改动即重建
pnpm build / pnpm dev / pnpm typecheck   # 同上的 pnpm 包装

bash scripts/link-profile.sh web [包名]   # 链接进 profile（默认 $DSH_PROFILE，其次 web）
bash scripts/unlink-profile.sh web [包名]
```

`pnpm` 在这台机器上不可用时，先 `npm install --cache .npm-cache`
（全局 npm cache 属于 root，必须换目录）。

## dsh 插件契约（踩过的坑）

一个 dsh 插件包同时有两半：

| 半侧 | 入口 | 形态 |
| --- | --- | --- |
| 宿主 | `package.json` 的 `main` → `lib/index.js` | Node ESM，导出 `name` / `inject` / `apply(ctx, config)` |
| 浏览器 | `exports["./client"]` → `lib/client.js`，由 `dsh.client.platform = "web"` 声明 | 经典脚本，执行 `window.__ModuleLoader__.load({ id, factory })` |

`factory(require)` 必须 **返回插件面对象**（`{ name, inject, apply }`）。它跑在经典脚本里，
所以不要依赖 ESM 的具名导出 —— 本仓库的做法是在 client 入口末尾
把三样东西挂到 `module.exports` 上。漏了这一步，宿主会报
"did not export the plugin apply"，而 bundle 本身看起来完全正常。

浏览器 bundle 只能 `require` 共享模块表里的东西：`react`、`react/jsx-runtime`、
`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`zod`。
`src/client/ui-primitives`、`dsh-client-store`、`dsh-client-ui-slots` 这些都 **不在** 表里，
需要 UI 组件就自己写（本仓库用 `createElement` + `--dsw-*` 主题变量，零依赖）。

宿主侧要用浏览器访问的服务（路由、RPC）时，注册在 `ctx.connection` 上：

```ts
ctx.inject(['connection'], (scope) => {
  const register = scope.get('connection').fetch.register
  ctx.effect(() => register({ path: '/api/x', methods: ['GET'], requestBody: 'buffered', fetch }), 'label')
})
```

`path` 是挂在共享通道上的完整路径（写 `/api/aurora/system-stats`），浏览器
直接 `fetch('/api/aurora/system-stats')` 即可，认证与 Host/Origin 校验由连接层负责；
精确路由只接受 owner Peer，所以不要绕开它另开端口。

同理，浏览器侧的座位（slot）用 `ctx.slots.inject(座位名, () => ctx.slots.register({ name, id, order }, Component))`。
本包用的是 `shell.overlay`（覆盖整个框架的列表座位）；座位如果还没声明，`inject` 会自动等它出现。

## profile 与安装

- profile 目录：`$DSH_HOME/profiles/<name>`（这台机器 `DSH_HOME=/volume2/docker/dsh/home`）。
- 插件由 profile 的 `package.json` 的 `dsh.profile.bundles` 列表决定加载，`cordis.patch.yml` 是其用户层。
- `dsh plugin --profile web add --save-prod file:<dir>` 会把包 **按 `files` 白名单复制** 进
  `node_modules`（不是软链）。所以：
  - `package.json` 的 `files` 必须覆盖全部产物（`lib/**/*.js`，含 `lib/host/`）；
  - 改完代码要重新 `pnpm build` **再** 跑一次 `link-profile.sh`。
- 不要手写 profile 的 `cordis.patch.yml` 去插没有 `name` 的行；插件管理器的
  `pluginManager/setBundleEnabled` 是官方开关，会刷新 bundle 列表。
- 宿主 `dsh web` 启动后，客户端 bundle 的 revision 由 `lib/client.js` 的 mtime/size 派生；
  改完文件重新 link 一次即可让已打开的页面在下一次刷新拿到新 graph。

## 新包清单

1. 复制 `packages/aurora-system-stats`，改 `package.json` 的 `name`/`description`，
   `cordis.patch.yml` 的 row id 与 `name`，以及 `src/client/index.ts` 末尾和
   `JSON.stringify(ID)` 相关的 id（构建脚本用包名做 loader id）。
2. host 入口放 `src/host/index.ts`，client 入口放 `src/client/index.ts`；
   构建脚本对这两个路径做约定式发现。
3. 公共类型放 `src/types.ts`，两端都从那里 `import type`。
4. 跑 `node scripts/each.mjs build && node scripts/each.mjs typecheck`。

## 悬浮球这一版的约定

- **水位球不是环**：`src/client/waterball.ts` 画一个圆形裁剪里的 SVG，水面靠
  `translate(0 y)` 定位，波浪是两个错相位的 `path` 各自平移。想改颜色只改该文件顶部的
  `WATER` 表；不要退回 `stroke-dasharray` 的环。
- **悬停展开，点击钉住**：`aurora-root` 的 `onMouseEnter/onMouseLeave`（外加
  `onFocus/onBlur`）控制 `hovered`，点击切 `pinned`。不要把打开逻辑改回 `onClick`，
  也不要把面板移出 `aurora-root`——那会让"球 → 面板"的移动变成两次进出而闪收。
- **拖动时不出面板**：`showing = open && !drag.dragging`，否则卡片会跟着指针跑。
- **JSX 里别把注释插在 `h(` 和第一个参数之间**：esbuild 走 TS 先剥离类型，
  会把整段实参注释掉，报出来的是很远的 `Expected ":"`。注释要写在 `{` 属性对象里。
- 面板是一个独立组件 `AuroraPanel`，`placement === null` 表示"还没量到尺寸"，
  此时渲染成 `visibility: hidden`，量完（`ResizeObserver`）再定位。
- **球只能有一条边，而且由 SVG 画**：`<button>`（命中区）、`.aurora-ball` 容器、SVG
  任何一层都不要有 `border` / `inset` 阴影 / 外圈 `box-shadow`——多一层就是"圆里套一个圆"，
  `inset` 阴影还会盖在自己内容上面。正确的画法在 `waterball.ts`：一个 `circle` 填充玻璃
  渐变，`clipPath` 用同一个圆裁水，描边是同一个圆的 `stroke`，投影用
  `feDropShadow`（跟着圆走，不是方盒子）。
- dsh 的 shell 对所有 `button` 设了 `border-radius: var(--dsw-radius-md)`（12px）和
  `box-sizing: border-box`，所以按钮必须 `box-sizing: content-box` + `border: 0` +
  `background: none`；但**光改这个并不能去掉灰圈**，灰圈来自额外那层边。
- **圆的形状交给 CSS，不交给绘制**：`.aurora-ball` 是固定方形 + `border-radius: 50%`
  + `overflow: hidden`，形状由盒子决定。**不要**再给球加 SVG `feDropShadow`、偏心的
  radial 高光、或画出来的 rim 圆来"修饰边界"——这些会让一个数学上正圆看起来像歪的鸡蛋
  （投影只落底部 → 下沿变胖；高光偏左上 → 上沿变瘦）。水只画波浪，靠盒子裁圆。
- 静止状态不要描边：白底白球上 1px 描边就是那圈"轮廓"；需要边界就用盒子自身的
  浅色渐变（surface 掺一点 brand），不要用 stroke / inset 线。

## 代码风格

- TypeScript 严格模式（`noUncheckedIndexedAccess` 打开），host 侧不引入 dsh 内部包的运行期依赖。
- 注释写在"为什么"上，不写"做了什么"；对外导出的符号都要有 JSDoc。
- 浏览器侧每个组件自己起状态，不碰其他插件的 store；样式选择器统一 `aurora-` 前缀。
