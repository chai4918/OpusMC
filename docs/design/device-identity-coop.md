# 设计：设备唯一身份 + 局域网合作（无账号）

- 状态：**草案（待评审）**
- 关联：`docs/design/server-authoritative-multiplayer.md`（账号/角色方案，本文件取代其 P0 身份部分）
- ADR：`docs/adr/0002-device-identity-instead-of-accounts.md`

---

## 1. 需求解读

目标：**不引入账号、密码、角色创建/登录**。每台设备首次访问自动获得唯一身份；多台设备进入同一世界即形成多人合作。

必须区分两层：

| 层 | 目标 | 工作量 |
|---|---|---|
| **身份** | 设备唯一、昵称、玩家状态归属、世界归属/加入 | 小（S0，3–5 天） |
| **联机** | 玩家互相可见、方块一致、时间一致、聊天 | 中（S1，2–3 周） |

**S0 只解决身份与安全共享，不产生实时多人**；S1 才是“多设备一起玩”。

| 能力 | S0（设备身份 + 租约） | S1（实时合作） |
|---|---|---|
| 免注册、自动身份 | ✅ | ✅ |
| 世界归属 / 加入码 | ✅ | ✅ |
| 每设备独立玩家状态 | ✅ | ✅ |
| 两台设备同时在线 | ❌（等待或接管） | ✅ |
| 互相看见 / 名牌 / 聊天 | ❌ | ✅ |
| 方块修改实时一致 | ❌（独占写入） | ✅ |
| 时间/天气一致 | ❌（各自模拟） | ✅ 服务端统一 |
| 怪物/掉落物一致 | ❌ | ❌（S2） |

---

## 2. 设计原则

1. **设备即玩家**：`deviceId` 是唯一身份，没有账号/密码。
2. **无用户管理**：没有注册、登录、角色选择；只有昵称、世界加入码、房主操作。
3. **S0 单写者**：同一世界同一时间只允许一台设备处于“可写”状态，避免当前静默丢档。
4. **S1 多写者**：改成操作级同步；玩家状态按设备独立。
5. **服务端权威存储不变**：区块、世界、玩家状态仍以服务端为准。
6. **不破坏单机**：离线/本机模式保留，设备身份仅在服务器模式生效。

---

## 3. 身份模型（设备）

### 3.1 首次访问

```text
浏览器                                    服务端
  │ localStorage: clientKey(随机 32B)        │
  │ POST /api/device {clientKey, name?}     │
  │ ───────────────────────────────────────▶│
  │                                         │ 查 client_key_hash
  │                                         │ 不存在 → 创建 device
  │                                         │ 生成 token（32B）
  │ ◀───────────────────────────────────────│ Set-Cookie mcjs_device=token (HttpOnly)
  │                                         │ 返回 {deviceId, name, role}
```

- `clientKey` 存 `localStorage['mcjs-client-key']`，用于**Cookie 被清但本地存储还在**时找回同一设备。
- Cookie 是主要凭证；`SameSite=Lax`、`HttpOnly`、HTTPS 下加 `Secure`。
- 两者都清 → 新设备（旧玩家状态保留在服务端，但不自动认领）。
- 同一浏览器多个标签页 = 同一设备；不同浏览器/隐私窗口 = 不同设备。

### 3.2 昵称

- 默认 `玩家-3F2A`（deviceId 后四位）。
- `PATCH /api/device {name}`，2–16 字符，全服唯一（重名自动加后缀）。
- 不需要角色创建；昵称就是玩家名。

### 3.3 身份限制

- 设备令牌等同密码：拿到令牌即可冒充该设备 → 仅限可信局域网。
- 不支持跨设备继承进度；后续可加“迁移码”（导出/导入 deviceId+token）作为可选功能。

---

## 4. 世界归属与加入（无用户管理）

### 4.1 归属

- 世界有 `owner_device`、`visibility`（`private` / `lan`）、`join_code`（6 位）。
- 创建者自动成为 owner 与成员。
- `private`：只有成员可见；`lan`：局域网内所有设备可见。

### 4.2 加入方式

1. **加入码**：房主把 6 位码给另一台设备；对方输入后成为成员。
2. **局域网可见**：世界设为 `lan` 后，其他设备的世界列表出现「局域网世界」，点击即加入（也可要求码，二选一）。

> 加入码字符集避开易混字符：`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，6 位；服务端限速防爆破。

### 4.3 房主能力（不是“用户管理”）

- 改名、切换 private/lan、重新生成加入码、踢出设备
- 删除世界、备份/导出
- 服务器控制台：封禁设备、查看在线、强制关服

---

## 5. 存档与并发模型

### 5.1 当前问题（已实现部分）

- 世界级 `revision` + 整包 `stage/commit` 是**单写者**模型。
- 两台设备同时玩：后保存者 409，且自动保存是 quiet，可能静默丢失。

### 5.2 S0：世界级租约（安全轮流玩）

- 同一世界同一时间只有一个 **active lease**。
- 第二台设备进入时：
  - 提示「世界正在 <昵称> 的设备上运行」
  - 选择「等待」或「接管」
- 接管后：
  - 旧设备下一次心跳/保存收到 `LEASE_LOST`
  - 旧设备立即暂停并提示「另一台设备接管，已退出世界」，**不再写入**
- 好处：没有静默覆盖；不同设备轮流玩，各自的玩家状态保留。
- 玩家状态：`player_state(world_id, device_id)`，与世界的 revision 解耦，互不冲突。

### 5.3 S1：多设备同时在线

- 租约改为 `(world, device)`，不再独占世界。
- 玩家状态独立保存，不走世界 revision。
- 方块修改改为**操作流**：
  - 客户端 `setBlock/useBlock` → 服务端校验距离/权限/速率 → 应用 → 广播 → 落库
  - 所有端收到同一操作序列
- 世界时间/天气由服务端统一。
- 流体/重力/作物等**方块刻**由服务端执行（需要从客户端抽取 `world` 的 block-tick 逻辑）。
- 区块生成：见 §7.3。
- 怪物/掉落物：S1 可先由各端本地模拟（不保证一致），S2 收口到服务端。

---

## 6. S0 详细设计

### 6.1 数据库迁移（v2）

```sql
CREATE TABLE devices (
  id            TEXT PRIMARY KEY,          -- d + 随机
  client_key_hash TEXT NOT NULL UNIQUE,    -- sha256(clientKey)
  token_hash    TEXT NOT NULL UNIQUE,      -- sha256(token)
  name          TEXT NOT NULL COLLATE NOCASE,
  role          TEXT NOT NULL DEFAULT 'player', -- player|admin
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_devices_name ON devices(name);

ALTER TABLE worlds ADD COLUMN owner_device TEXT;
ALTER TABLE worlds ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE worlds ADD COLUMN join_code TEXT;
CREATE UNIQUE INDEX idx_worlds_join_code ON worlds(join_code) WHERE join_code IS NOT NULL;

CREATE TABLE world_members (
  world_id  TEXT NOT NULL,
  device_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'player', -- owner|player
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, device_id)
);

CREATE TABLE player_state (
  world_id  TEXT NOT NULL,
  device_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, device_id)
);

CREATE TABLE leases (
  world_id   TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
```

迁移旧数据（**已确认：旧世界直接删除，不做认领**）：

- v1 的世界没有 `owner_device`，属于“设备身份之前的旧数据”。
- v2 迁移时先自动备份 `data/backup/pre-v2-<时间>.db`，再执行：

```sql
DELETE FROM save_staging;
DELETE FROM chunks;
DELETE FROM player_state;
DELETE FROM leases;
DELETE FROM world_members;
DELETE FROM worlds;
```

- 日志记录删除的世界/区块数量；迁移后世界列表为空，由设备正常创建新世界。
- `admin` 角色仍授予首个完成初始化的设备（仅用于服务端管理：踢设备、封禁、关服），但**不再认领任何旧世界**。
- 浏览器 IndexedDB 中的本机存档不受影响；需要时可由新设备手动「导入本机存档」，导入后的世界归属该设备。

### 6.2 API（在现有 `/api` 上扩展）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/device` | 首次/重新绑定设备；`{clientKey, name?}` → 设 Cookie |
| GET | `/api/me` | 当前设备信息 |
| PATCH | `/api/device` | 改昵称 |
| GET | `/api/worlds` | 我的 + 已加入 + 局域网可见 |
| POST | `/api/worlds` | 创建世界（owner/join_code） |
| POST | `/api/worlds/join` | `{code}` 加入 |
| PATCH | `/api/worlds/:id` | 改名 / visibility / 重新生成加入码（owner） |
| DELETE | `/api/worlds/:id` | 软删除（owner） |
| GET | `/api/worlds/:id` | 世界信息 + 当前设备 player_state |
| PUT | `/api/worlds/:id/player` | 保存当前设备玩家状态（独立） |
| POST | `/api/worlds/:id/lease` | `{takeover?}` 获取/接管 |
| POST | `/api/worlds/:id/lease/heartbeat` | 心跳 |
| POST | `/api/worlds/:id/lease/release` | 释放 |
| POST | `/api/worlds/:id/kick` | `{deviceId}` 踢出（owner） |
| POST | `/api/worlds/:id/save/stage` | 需有效租约 |
| POST | `/api/worlds/:id/save/commit` | 需有效租约 + revision |
| GET | `/api/worlds/:id/chunks` | 需成员身份 |

所有接口（除 `/api/health`、`/api/device`）要求设备 Cookie。

错误码新增：

- `LEASE_HELD`（409，附 holder 昵称）
- `LEASE_LOST`（409，旧设备被接管）
- `NOT_MEMBER`（403）
- `DEVICE_BANNED`（403）
- `INVALID_JOIN_CODE`（404/429）

### 6.3 客户端

- `MCStore.init()`：
  1. 确保 `clientKey`
  2. `POST /api/device`（若 Cookie 有效可跳过）
  3. `GET /api/me` → 昵称/角色
- 世界列表分三组：
  - 我的世界（owner）
  - 已加入
  - 局域网世界（visibility=lan）
- 底部/侧边：昵称、加入码输入框、「创建世界」。
- 进入世界：
  1. `POST lease`
  2. 若 `LEASE_HELD` → 弹窗「等待 / 接管」
  3. 获取世界 + player_state + 区块
  4. 每 15s 心跳
- 保存：
  - 玩家状态：`PUT /player`（不参与世界 revision）
  - 世界方块/元数据：保持 stage/commit，但必须带租约
- 被接管：心跳 409 → 立即保存失败提示 → 回到标题（不写服务端）。

### 6.4 UI 文案

- 首次进入：`本机身份：玩家-3F2A（可改名）`
- 世界占用：`该世界正在 <昵称> 的设备上运行`
- 接管危险操作二次确认
- 加入码：`加入局域网世界` + 输入框
- 房主设置：可见性、加入码、踢人

### 6.5 安全

- 设备令牌 HttpOnly Cookie；不写 JS 可读存储（clientKey 不是凭证）。
- 所有世界/区块/玩家操作校验设备归属或成员关系。
- 加入码限速（每设备每 10 分钟 10 次）。
- 昵称过滤控制字符，长度限制。
- LAN 信任模型；公网必须 HTTPS。

---

## 7. S1 实时合作（概要设计）

### 7.1 传输

- WebSocket `/ws`，Cookie 鉴权。
- 消息信封：`{v:1, t, seq?, ack?, d}`。
- 客户端 10–15Hz 上报玩家姿态/动作；服务端广播。
- 快照：玩家列表 + 方块操作 + 时间/天气 + 事件。

### 7.2 方块并发

- 操作：`{op:'setBlock', x,y,z,id,meta,seq}`。
- 服务端校验：成员、租约（可选）、距离、速率、坐标、方块 ID。
- 应用并追加 `block_ops`（或直接更新 chunks）+ 广播。
- 客户端乐观应用，收到广播按 `seq` 去重/校正。
- 区块保存从“整包 commit”改为“增量落库”，不再有世界 revision 冲突。

### 7.3 区块生成（关键）

两种路线：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 客户端确定性生成 + 服务端授权** | 缺少区块时服务端把生成权授予一台设备；该设备用现有确定性生成器生成并上传；其他端等待 | 小，但要求所有客户端版本一致；生成器变更需版本号 |
| B. 服务端生成 | 把 `world.js` 生成器抽到 Node（P0.5） | 大，但最稳 |

**建议 S1 走 A**：`generator_version` 已存在；生成结果上传后服务端校验并广播；之后只走方块操作。

### 7.4 世界时间 / 天气

- 服务端维护并广播；客户端不再自己推进。
- 睡觉：S1 先做“全员在线时投票”，S2 完整规则。

### 7.5 怪物 / 掉落物

- S1 先各端本地模拟（会出现不同步，但方块/玩家一致）。
- S2 改为服务端权威实体 + 客户端插值。

### 7.6 玩家状态

- 每设备独立保存位置/背包/生命/进度；`PUT /player` 每 10–15 秒或事件触发。
- 死亡/重生按设备独立。

---

## 8. S2 完整权威（概要）

- 服务端 20TPS tick：方块刻、流体、作物、怪物、掉落物、TNT、箭。
- 客户端预测 + 校正；实体快照/增量。
- 容器/背包事务由服务端校验。
- 睡觉/权限/反破坏/审计。
- 复用 `docs/design/server-authoritative-multiplayer.md` 的 P1/P2 协议与共享核心设计。

---

## 9. 测试与验收

### S0

- 首次访问自动获得设备；刷新/重启后仍是同一设备
- Cookie 清 + clientKey 在 → 找回同一设备
- 两台设备：A 进入；B 进入提示占用；B 接管；A 收到 LEASE_LOST 且不再写入
- 玩家状态按设备隔离；A/B 轮流进入各自位置/背包正确
- 加入码加入、错误码限速、private 不可见、lan 可见
- 旧库升级：先备份，旧世界/区块/玩家状态全部删除；新设备从空列表开始
- 越权：非成员读世界/区块 → 403
- 保存：租约过期/丢失 → 409，不写半包

### S1

- 两台设备同世界：互相可见、移动/名牌/聊天
- 双方挖同一方块：只有一个操作生效，双方一致
- 同时放方块：操作序列一致
- 时间/天气一致
- 断线重连恢复位置/背包
- 5000 区块世界：按需加载 <3s 可玩

---

## 10. 任务拆解与估算

### S0（3–5 天）

| ID | 任务 | 验收 |
|---|---|---|
| D1 | 设备表/令牌/Cookie/初始化 | 自动身份、刷新保持、clientKey 找回 |
| D2 | 鉴权中间件 + 设备昵称 | 未授权 401；改名生效 |
| D3 | 世界 owner/成员/可见性/加入码 | 加入/踢出/私有隔离 |
| D4 | player_state 按设备 | 两台设备互不覆盖 |
| D5 | 世界租约 + 接管 | 占用提示、LEASE_LOST、不静默写 |
| D6 | 客户端身份/世界列表/加入码 UI | 双设备手工验收 |
| D7 | v2 迁移：自动备份 + 删除旧世界 | 旧数据清空、备份可恢复、无残留区块 |
| D8 | 测试/文档/安全用例 | 全部通过 |

### S1（2–3 周）

玩家同步 → 方块操作流 → 区块生成权 → 时间/天气 → 聊天/名牌 → 重连 → 测试。

### S2（3–5 周）

共享核心 + 权威 tick + 实体/容器/睡觉/权限。

---

## 11. 待确认决策

| # | 决策 | 建议 |
|---|---|---|
| 1 | 加入方式 | 加入码 + 可选 LAN 可见 |
| 2 | 旧世界（升级前） | **直接删除**（已确认；迁移前自动备份） |
| 3 | S1 区块生成 | 客户端确定性生成 + 服务端授权（方案 A） |
| 4 | S1 怪物 | 先不同步，S2 收口 |
| 5 | 昵称唯一 | 全服唯一，重名自动后缀 |
| 6 | 设备迁移 | 暂不做；后续加迁移码 |
| 7 | S0 第二台设备 | 只能等待或接管，不允许同时写 |

---

## 12. 与现有实现的关系

- 已实现的云存档（设备身份之前）平滑升级：新增设备表与租约；**升级 v2 时删除旧世界**（迁移前自动备份），世界列表从空开始。
- 浏览器本机存档不受影响，可由新设备手动导入并归属该设备。
- 现有 `MCStore` 需增加设备初始化、加入码、租约与 player_state 接口。
- 现有两阶段保存保留，但 S0 增加租约校验；S1 改为操作流后不再需要整包 revision。
- 账号/角色/登录方案（旧设计）暂不实施；密码、角色选择、会话表均不需要。
