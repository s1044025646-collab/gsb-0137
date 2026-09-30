# twsh — 栅格地形汇流与流域划分后端

纯本地运行的规则栅格（regular DEM）水文分析后端。提供 **REST API、CLI、合成高程生成器、自动化测试**，不包含网页、地图渲染，也不连接任何真实水文平台。

技术栈：TypeScript（Node 原生类型剥离直接运行）、Node.js（内置 `node:sqlite`、内置 HTTP、内置 test runner）。**运行时零第三方依赖**。

## 能力与方法

- **D8 单流向**：按真实中心距比较坡降 `(z_i - z_j)/(d·cellSize)`，正交 `d=1`、对角 `d=√2`，对角不被人为放大距离惩罚。
- **平坦区确定性消解**：多源 BFS 距离标签，每一条平坦边严格向标签更小的邻格流动，因此**无环**；边界格与已存在下坡路径的格作为距离 0 锚点。
- **洼地处理**
  - `fill`：Priority-Flood（Barnes 2014 风格），只抬升、不改动原始高程；逐格记录抬升量 `delta`、来源/处理状态、排水依据（spill 单元与溢流水位）。
  - `breach`：从洼地最低点向最近边界沿直线刻槽降低（确定性）。
  - `none`：不预处理，保留内部 sink。
  - **封闭有效区域**（被 NoData 围墙或高地完全包围、无外排路径）明确报告为 closed，保留为内部汇，**绝不通过随意扰动原高程掩盖无解**。
- **上游汇流面积**：Kahn 拓扑序累加，区分**像元数量**与**实际面积**（`像元数 × cellSize²`）。
- **河网阈值提取**：按上游像元数阈值；报告同时给出像元数与平方米。
- **指定出口分水区**：逆向收集所有最终汇入指定出口的格。
- **版本与隔离**：更换出口或填洼规则生成**新分析**；每个分析保存每格的原始高程 `raw_z`、有效高程 `eff_z`、抬升量、来源状态、方向、接收者、上游像元数与面积。原始高程永不被预处理覆盖。
- **幂等**：相同 `(地形, 策略, 阈值, 出口, requestKey)` 返回同一分析。

### 边界与 NoData 语义

- **NoData 是屏障（barrier）**：水不能流入或穿过；NoData 标记值（如 `-99` 或 `null`）**绝不被当作低洼高程**。
- **有效边界格是出口（outlet）**：可向建模区域外排水（方向码 `255 = DIR_OUT`）；边界不是墙。
- 被 NoData 完全封闭的有效区无法外排，报告为 closed basin 并作为内部 sink。

### 方向码

ESRI D8：`1=E 2=SE 4=S 8=SW 16=W 32=NW 64=N 128=NE`；`0=内部 sink`，`255=流出边界`。

### 每格来源/状态码（`source_state`）

`0 未改动 · 1 填洼抬升 · 2 刻槽降低 · 3 原始平坦(确定性消解) · 4 封闭区 · 5 NoData`

## 环境要求

- Node.js **>= 22.5**（开发/验证于 v25；使用内置 SQLite 需加 `--experimental-sqlite`）。
- 仅做类型检查时需要 `typescript` 与 `@types/node`（已列 devDependencies）。

## 安装

```bash
npm install        # 仅安装类型检查所需 devDependencies；运行本身无需它们
```

## 运行 API 服务

```bash
npm start
# 只绑定 127.0.0.1，端口 0 => 由系统自动分配，启动时打印实际地址
# 数据库默认 data/app.sqlite，可用 TWSH_DB 覆盖
```

启动日志形如：`[twsh] API listening on http://127.0.0.1:51234`。停止：在该终端按 `Ctrl+C`（只关闭本项目进程；不会管理其他进程）。

### 主要端点

- `GET  /health`
- `POST /terrains`  导入地形（JSON 二维数组，`null` 或等于 `noDataValue` 表示缺测）
- `GET  /terrains?limit=&offset=`  分页
- `GET  /terrains/:id`
- `POST /terrains/:id/analyses`  `{fillStrategy, threshold, outlets:[{row,col}], requestKey}`
- `GET  /terrains/:id/analyses?limit=&offset=`
- `GET  /analyses/:id`
- `GET  /analyses/:id/report`           机器可读报告（JSON）
- `GET  /analyses/:id/trace/:row/:col`  下游路径
- `GET  /analyses/:id/matrix/<kind>?format=csv&outlet=<cellIndex>`
  - `kind`：`raw|filled|delta|source|direction|upstream|area|watershed`

错误统一为 `{"error":{"code","message","details?"}}`，校验失败 `400`，未找到 `404`。分页返回 `items,total,limit,offset,hasMore`。

## CLI

```bash
# 导入 JSON 矩阵
npm run cli -- import myterrain data/sample-terrain.json --cell-size 2

# 合成地形（确定性种子，可带洼地/NoData孔/平地）
npm run cli -- synthetic demo 12 12 --seed 7 --pit --flat --cell-size 5

# 检查洼地（打印 BEFORE/AFTER 状态、抬升量、排水依据、封闭区）
npm run cli -- depressions 1 fill

# 预处理 + 汇流 + 流域（一次分析，打印前后状态）
npm run cli -- analyze 1 --strategy fill --threshold 5 --outlet 4,2 --key run1

npm run cli -- analyses 1          # 列出某地形的历史分析（旧结果隔离）
npm run cli -- trace 1 0 0         # 查询某格下游路径
npm run cli -- watershed 1         # 查看各出口分水区（像元数与实际面积）
npm run cli -- compare 1 2 5 10    # 不同阈值对比（各自独立分析）
npm run cli -- report 1            # 机器可读报告
npm run cli -- export 1 direction --csv --out tmp/dir.csv
npm run cli -- export 1 watershed --outlet 22 --out tmp/ws.json
```

`--outlet` 多个用分号：`--outlet 4,2;2,4`。数据库位置用环境变量 `TWSH_DB`。

## 测试

```bash
npm test           # 30 个自动化测试（核心算法、持久化、API、CLI）
npm run demo       # 可重复的端到端演示（独立 tmp/demo.sqlite，含重启校验）
npm run typecheck  # TypeScript 类型检查
```

夹具覆盖：单坡面、双山谷、封闭洼地、大片平地、NoData 孔洞、边界出口、NoData 围墙封闭区、输入顺序变化。测试断言：手工小栅格的流向与面积、**流向无环**、**面积/像元守恒**、流域归属、重复运行确定性、旧结果隔离、失败路径、事务回滚、重启后持久化。

所有数据与临时文件都在本项目的 `data/` 与 `tmp/` 目录内；删除这两个目录即可完全清理。

## 目录结构

```
src/core   类型、栅格、合成生成、洼地处理、D8/汇流/分水区、校验、导出
src/db     可重复迁移、事务仓储（地形/分析/逐格/洼地/分水区/报告）
src/api    仅本机的 HTTP 服务与路由
src/cli    命令行
test       夹具、核心/DB/API/CLI 测试、端到端演示
data       SQLite 与示例矩阵
tmp        临时数据库与导出（可安全删除）
```
