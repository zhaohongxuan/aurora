# aurora-system-stats

Aurora 的网页悬浮球：在 DeepSeek Harness 网页 GUI 右下角放一颗实时指标球，
展示 **CPU、内存、磁盘、load**，点开是完整面板。

## 它长什么样

**收起**：一颗 58px 的圆环，环内是 CPU 使用率，环的配色随压力变化
（<70% 绿、70–90% 黄、≥90% 红），右上角一个小圆点表示连接状态。

**展开**（点一下球）：

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
| 点圆球 | 展开 / 收起面板 |
| 拖动圆球 | 随手放到任意位置（自动避开视口边缘），位置按浏览器记住 |
| `⤾` | 回到默认的右下角 |
| `✕` 或 `Esc` | 收起面板（再点球可以打开） |
| 刷新页面 | 位置与展开状态都保留 |

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
    ├── orb.tsx            # 悬浮球 + 面板
    ├── charts.ts          # SVG 圆环与曲线
    ├── useStats.ts        # 全页共享的轮询器
    ├── useDragPosition.ts # 拖拽 + localStorage 位置记忆
    ├── format.ts          # 百分比 / 字节 / 时长格式化
    ├── copy.ts            # 中英文案
    └── styles.css         # 全部走 --dsw-* 主题变量
```

## 实现要点

- **不占布局**：注册在 `shell.overlay` 座位，浮在三栏之上；收起时只有一个圆球接收点击。
- **不依赖 dsh 的内部模块**：面板全部用 `createElement` 写，构建产物只需 `require("react")`，
  其余模块都在 bundle 内，HMR 换包时不会牵连别的插件。
- **样式随主题走**：颜色全部来自 `--dsw-alias-*`，亮/暗色自动跟随；样式表以字符串注入，
  打上 `data-plugin` / `data-plugin-css` 标记，插件卸载时由模块系统一并摘掉。
- **采样不抖动**：250ms 内的多次请求共用一次采样；磁盘容量 5 秒才重扫一次。
- **采样失败不炸**：单次失败保留上一个快照，球变灰、面板顶部提示"连接中断"。

## License

MIT
