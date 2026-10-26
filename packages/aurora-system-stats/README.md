# aurora-system-stats

Aurora 的网页悬浮球：在 DeepSeek Harness 网页 GUI 右下角放一颗**装有绿色水位**的玻璃球，
水位高就是 CPU 使用率高；鼠标悬停时浮出完整面板，展示 **CPU、内存、磁盘、load**。

## 它长什么样

**收起**：一颗 58px 的玻璃球，里面是**水位**——水面高度就是 CPU 使用率，
水面有两层错相位的波浪在缓慢流动，球内叠着当前百分比。水位颜色随压力变化
（<70% 绿、70–90% 琥珀、≥90% 红）；宿主断开时水位停止流动并褪色。

**展开**（鼠标移到球上）：

```
┌────────────────────────────────────────┐
│ 系统资源            DX4600-A366 · linux/x64  ⤾ ✕ │
│ ┌────────┬────────┬────────┐          │
│ │ CPU    │ 内存   │ 负载   │  ← 三个数字块 │
│ │ 19%    │ 61%    │ 0.79   │           │
│ │ 4 核心 │ 4.8/7.6G│ 0.7·0.7│           │
│ └────────┴────────┴────────┘          │
│ CPU      18.7%           ~~~~~~~~~~~~  │ ← 曲线是最近 60 次采样
│ 内存     61.1%      5.9 GB ~~~~~~~~~~~ │
│ ▮▮▮▮▮▮▮▮   ← 每个核心一格               │
│ ── 磁盘 ─────────────────────────────── │
│ /        ▓▓▓░░░░░░  4.77 GB / 18.3 GB  26% │
│ /volume1 ▓▓▓▓▓▓▓▓░ 392 GB / 450 GB   87% │
│ 运行 2d 13h   交换 24%          Node 859 MB │
└────────────────────────────────────────┘
```

## 交互

| 动作 | 结果 |
| --- | --- |
| 鼠标悬停球 | 浮出面板（移开就收） |
| 鼠标从球移到面板 | 面板保持打开——两者是同一个悬停区域 |
| 点球 | 把面板**钉住**，移开鼠标也不收；再点一次取消 |
| 拖动球 | 随手放到任意位置（自动避开视口边缘），位置按浏览器记住；拖动时不出面板 |
| `⤾` | 回到默认的右下角 |
| `✕` 或 `Esc` | 关掉面板（钉住状态下也可） |
| 键盘 Tab 聚焦 | 等同悬停，面板同样浮出 |
| 刷新页面 | 位置与"是否钉住"都保留 |

面板会自己找位置：球在屏幕右半边时面板向左展开，下方放不下就翻到上方。

## 数据从哪来

宿主半侧在共享的 `/api` 通道上注册一条精确路由：

```
GET /api/aurora/system-stats   →   { ok: true, value: SystemStatsSnapshot }
```

这条路由挂在 dsh 已认证的连接通道里，因此沿用宿主的 Host/Origin 校验和浏览器凭据检查，
不额外开端口。浏览器每 2 秒拉取一次（可配置），标签页隐藏时暂停，恢复可见时立即补一次。

采样来源：

| 指标 | Linux 来源 | 其他平台 |
| --- | --- | --- |
| CPU 使用率 / 每核 | `/proc/stat` 两次 tick 的差值 | 用 load 除以核数估算 |
| CPU 忙时 / 运行时长 | `/proc/stat`、`os.uptime()` | `os.uptime()` |
| Load 1/5/15 | `/proc/loadavg`（比 `os.loadavg()` 更新快） | `os.loadavg()` |
| 内存 / swap | `/proc/meminfo` | `os.totalmem()` / `os.freemem()` |
| 磁盘 | `/proc/mounts` + `statfs`，5 秒刷新一次 | `df -Pk` |
| 进程占用 | `process.memoryUsage()` | 同左 |

`/proc/mounts` 里的虚拟文件系统（tmpfs、overlay、cgroup 等）和非 `/` 的系统目录会被过滤掉，
最多显示 4 个文件系统，`/` 永远排第一。

## 配置

在 profile 里给这一行加配置即可（`cordis.patch.yml` 或设置 → 插件的配置页）：

```yaml
- id: aurora-system-stats
  name: aurora-system-stats
  config:
    intervalMs: 2000   # 轮询间隔，500–60000，默认 2000
```

## 安装

```bash
# 从仓库根目录
pnpm build
bash scripts/link-profile.sh web
```

然后在 **设置 → 插件** 里确认 `aurora-system-stats` 已启用，刷新页面。
卸载：`bash scripts/unlink-profile.sh web aurora-system-stats`。

## 结构

```
src/
├── types.ts               # 两端共用的快照类型
├── cordis.ts              # 本包用到的 Cordis 接口子集（运行期由 profile 提供）
├── host/
│   ├── index.ts           # Cordis 插件：注册 /api 路由
│   └── sampler.ts         # 采样器：/proc、os、statfs
└── client/
    ├── index.ts           # 浏览器插件：注册 shell.overlay 座位
    ├── orb.tsx            # 悬浮球、悬停状态、面板组件
    ├── waterball.ts       # SVG 水位球（双层波浪 + 圆形裁剪）
    ├── charts.ts          # SVG 曲线（面板里的走势图）
    ├── useStats.ts        # 全页共享的轮询器
    ├── useDragPosition.ts # 拖拽 + localStorage 位置记忆
    ├── format.ts          # 百分比 / 字节 / 时长格式化
    ├── copy.ts            # 中英文案
    └── styles.css         # 全部走 --dsw-* 主题变量
```

## 实现要点

- **不占布局**：注册在 `shell.overlay` 座位，浮在三栏之上；收起时只有圆球接收鼠标。
- **悬停区 = 球 + 面板**：两者都在同一个 `aurora-root` 里，移出球去够面板不会闪收
  （离开后延迟 60ms 再收，足够跨过间隙）；点击是"钉住"而不是"打开"。
- **水位是画出来的**：一个被圆形裁剪的 SVG，两层正弦叠加的波峰按不同速度平移，
  水面高度由 `translate(0 y)` 直接给出；`prefers-reduced-motion` 下波浪停住。
- **不依赖 dsh 的内部模块**：面板全部用 `createElement` 写，构建产物只需 `require("react")`，
  其余模块都在 bundle 内，HMR 换包时不会牵连别的插件。
- **圆是真的圆**：dsh 的壳把每个 `button` 设成 12px 圆角和 border-box，所以 `<button>` 只当
  命中区（透明、无边框），玻璃球、描边和阴影都画在内层圆形容器上。
- **样式随主题走**：颜色全部来自 `--dsw-alias-*`，亮/暗色自动跟随；样式表以字符串注入，
  打上 `data-plugin` / `data-plugin-css` 标记，插件卸载时由模块系统一并摘掉。
- **采样不抖动**：250ms 内的多次请求共用一次采样；磁盘容量 5 秒才重扫一次。
- **采样失败不炸**：单次失败保留上一个快照，球变灰、面板顶部提示"连接中断"。

## License

MIT
