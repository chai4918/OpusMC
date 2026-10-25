# 设计：局域网多人 / 角色系统 / 服务端权威存储

- 状态：**修订稿 v2（已吸收评审结论与 4 项决策）**
- 范围：P0 可落地设计；P1/P2 只定接口与边界
- 目标读者：实现本项目的 AI Agent 与人工评审者
- 关联文档：`README.md`、`AGENTS.md`、`docs/adr/0001-server-authoritative-storage.md`

**已确认决策**

1. P0 即实现**按视野懒加载区块**（不做“全量拉取 + 上限”退路）
2. 保存采用 **staging 两阶段**（分片上传 + 原子 commit）
3. 世界默认可见性 **private**
4. 游客模式 **默认关闭**（服务器配置显式开启）

---

## 1. 目标与非目标

### 目标

1. **P0**：账号注册/登录、角色创建/选择、服务端权威存档（单人玩法不变）、区块懒加载、本机存档迁移。
2. **P1**：局域网内 2–8 人同服，服务端权威模拟世界，玩家互相可见、可共同挖建。
3. **P2**：生物、掉落物、TNT、容器、睡觉、进度等玩法状态在多端一致。

### 非目标（本设计不做）

- 公网联机、NAT 穿透、跨服大厅
- 自定义皮肤上传（当前只有 `steve` 模型）
- P0 阶段的服务端模拟（P0 客户端仍是模拟权威，服务端是**存储权威**）

### 信任边界

- P0：客户端可信（单机），服务端校验身份、归属、版本、租约、大小。
- P1+：客户端不可信，只接受“输入/意图”，状态由服务端产生。

---

## 2. 阶段与交付物

| 阶段 | 交付 | 依赖 | 预估 |
|---|---|---|---|
| **P0** | 登录/角色/云存档/懒加载/迁移，离线单人保留 | 无 | 17–24 人天 |
| **P0.5** | 共享核心抽取 + headless 回放 + 生成器 hash 门禁 | P0 | 4–6 人天 |
| **P1** | WebSocket + 权威 tick + 玩家同步 + 区块订阅 | P0.5 | 8–12 人天 |
| **P2** | 生物/背包容器/爆炸/睡觉/权限 | P1 | 6–10 人天 |
| **P3** | LAN 发现、重连、备份、皮肤、文档 | P2 | 3–5 人天 |

---

## 3. 总体架构

```
┌──────────────────────────── 浏览器 ────────────────────────────┐
│ admin/UI (screens.js, ui.js, touch.js)                         │
│ render/mesher/audio                                            │
│ game.js ── 客户端模拟（P0 权威 / P1 预测）                      │
│ net/api.js ── fetch /api/*（P1 增加 /ws）                      │
│ net/store.js ── LocalStore(IndexedDB) | RemoteStore + 队列     │
└───────────────────────────────┬────────────────────────────────┘
                                │ HTTP(S) 同源
┌───────────────────────────────▼────────────────────────────────┐
│ server/  Node 22（零第三方依赖）                                │
│  index.js        静态资源 + 路由 + 优雅退出                     │
│  http.js         请求体/限额/CSRF/Cookie                        │
│  api.js          账号/角色/世界/区块/存档                        │
│  auth.js         scrypt（并发信号量）+ 会话                      │
│  db.js           node:sqlite（WAL）+ 迁移 + 备份                │
│  chunk-codec.js  区块二进制编解码                                │
│  staging.js      saveId 暂存与清理                               │
│  rooms.js        （P1）权威 tick                                 │
└───────────────────────────────┬────────────────────────────────┘
                                │
                        data/mcjs.db + data/backup/
```

**端口**

- 在线多人/云存档：Node `http://0.0.0.0:8765`（与离线静态服务器端口相同，二者不可同时运行）
- 离线静态：`tools/serve.py` 默认 `8765`（如需与 Node 同时运行，可 `python tools/serve.py 8766`）

---

## 4. 目录与文件变更

### 新增

```
server/
  index.js            入口：配置、静态服务、/api、优雅退出
  config.js           端口/数据目录/限额/会话/guest 开关
  http.js             JSON、body 限制、限流、Cookie、Origin/CSRF
  db.js               SQLite 打开、PRAGMA、迁移、备份
  auth.js             scrypt、会话、鉴权
  api.js              路由实现
  chunk-codec.js      区块二进制 <-> base64
  staging.js          saveId 暂存、TTL 清理
  static.js           no-cache 静态文件
  migrations/001.sql  初始结构
  test/*.test.js      node:test
game/js/net/
  api.js              fetch 封装、错误码、超时、版本检查
  store.js            Store 接口 + RemoteStore + SaveQueue
  sync-ui.js          同步状态提示
game/js/net/pending.js  IndexedDB pending 快照（按世界合并）
docs/contracts/api-v1.json   API 契约（唯一字段来源）
docs/design/server-authoritative-multiplayer.md  （本文）
docs/adr/0001-server-authoritative-storage.md
启动服务器(多人).bat
```

### 修改

| 文件 | 改动 |
|---|---|
| `game/js/save.js` | 保留 LocalStore；新增 Store 选择器；业务不再直接调用 DB |
| `game/js/game.js` | `DB.*` → `store.*`；`saveWorld` 两阶段；**区块懒加载**；成功后才清 dirty |
| `game/js/world.js` | `loadChunk` 支持“远端缺失 → 生成”的异步路径（P0 仅接回调） |
| `game/js/screens.js` | 「多人游戏」、登录/注册、角色选择/创建、服务器状态 |
| `game/js/ui.js` | `showInput` 支持 `type=password / placeholder` |
| `game/js/main.js` | 初始化 Store、恢复会话 |
| `README.md` | 多人/登录/服务器启动与安全说明 |

---

## 5. 客户端 Store 契约

```ts
interface WorldMeta {
  id: string; name: string; seed: string; mode: 'survival'|'creative'; flat: boolean;
  created: number; lastPlayed: number; time: number; weather: number; rainTarget: number;
  spawn: [number,number,number]; adv: object; stats: object; tutorial: number;
  player: PlayerState | null; blockEntities: Record<string, object>; mobs: object[];
  revision: number;                     // 服务端唯一版本；本地存档为 0
  origin: 'local'|'remote';
  visibility?: 'private'|'lan';
}

interface Store {
  init(): Promise<void>;
  status(): { mode:'local'|'remote'; online:boolean; pending:number; error?:string };
  listWorlds(): Promise<WorldMeta[]>;
  getWorld(id: string): Promise<WorldMeta|null>;
  createWorld(meta: Partial<WorldMeta>): Promise<WorldMeta>;
  renameWorld(id: string, name: string): Promise<void>;
  setVisibility(id: string, v: 'private'|'lan'): Promise<void>;
  deleteWorld(id: string): Promise<void>;

  // 懒加载
  getChunks(id: string, keys: Array<[number,number]>): Promise<{
    found: Map<number, ChunkRec>;     // key = ckey(cx,cz)
    missing: Array<[number,number]>;  // 服务端不存在 → 客户端可生成
  }>;

  // 两阶段保存（RemoteStore 内部实现 staging；LocalStore 直接写）
  saveWorld(id: string, snapshot: SaveSnapshot): Promise<SaveResult>;
  flush(): Promise<void>;
  importLocalWorlds(): Promise<ImportResult>;
}

interface SaveSnapshot {
  baseRevision: number;
  meta: Partial<WorldMeta>;
  player: PlayerState;
  chunks: ChunkRec[];
  leaseToken: string;
}

interface ChunkRec { cx:number; cz:number; b:Uint16Array|number[]; m:Uint16Array|number[] }
```

**规则**

- `getChunks` 只在 `missing` 中明确返回缺失时，客户端才生成新区块；网络错误必须重试，**不得生成**（否则覆盖已有建筑）。
- `saveWorld` 成功 resolve 后才清 `dirty`；失败保留 pending。
- `LocalStore` 不需要 lease（leaseToken 传 `''`），直接写 IndexedDB。
- 懒加载初始预取：出生点周围 `(2R+1)²` 个区块（R 为渲染距离，默认 2 圈），完成后才进入 `play`。

---

## 6. HTTP API（P0）

统一前缀 `/api`，JSON；错误 `{ "error": { "code": "...", "message": "..." } }`。
所有字段以 `docs/contracts/api-v1.json` 为准。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok, apiVersion, features:{guest}}` |
| POST | `/api/register` | `{username,password}`；guest 仅在配置开启时允许 |
| POST | `/api/login` | 设置 HttpOnly Cookie |
| POST | `/api/logout` | 删除会话 |
| GET | `/api/me` | 账号 + 角色 + cookie 状态 |
| GET | `/api/characters` | 我的角色 |
| POST | `/api/characters` | `{name, model?}` |
| PATCH | `/api/characters/:id` | 改名 |
| DELETE | `/api/characters/:id` | 软删除 |
| GET | `/api/worlds` | 可见世界（owner/member） |
| POST | `/api/worlds` | `{name,seed,mode,flat,characterId,visibility?}` |
| PATCH | `/api/worlds/:id` | 改名 / visibility |
| DELETE | `/api/worlds/:id` | 软删除（owner） |
| GET | `/api/worlds/:id` | meta + 当前角色 player_state + revision |
| POST | `/api/worlds/:id/chunks/query` | `{keys:[[cx,cz],...]}` → `{found:[...], missing:[...]}` |
| POST | `/api/worlds/:id/lease` | 获取/接管租约 `{characterId, takeover?}` |
| POST | `/api/worlds/:id/lease/heartbeat` | 心跳 `{leaseToken}` |
| POST | `/api/worlds/:id/lease/release` | 主动释放 |
| POST | `/api/worlds/:id/save/stage` | `{saveId, chunks:[...]}`，可多次 |
| POST | `/api/worlds/:id/save/commit` | `{saveId, baseRevision, leaseToken, meta, player}` |
| POST | `/api/worlds/:id/save/abort` | `{saveId}` |
| POST | `/api/worlds/:id/import` | 迁移：stage + commit 复用 |

### 两阶段保存

```
1) POST /save/stage   { saveId, chunks:[{cx,cz,b,m} ≤64] }   × N
2) POST /save/commit  { saveId, baseRevision, leaseToken, meta, player }
```

- `stage`：写入 `save_staging(world_id, save_id, cx, cz, data)`，幂等（UPSERT）；单批 ≤64 区块 / 4MB。
- `commit` 单事务：
  1. 校验会话、角色、租约、`baseRevision`
  2. `INSERT … ON CONFLICT` 将 staging 合并进 `chunks`
  3. 更新 `worlds`（meta/time/weather/revision+1）
  4. 更新 `player_state`
  5. 删除该 `saveId` 的 staging
  6. 写 audit
- `saveId` 由客户端生成 UUID；重试复用同一个 `saveId`。
- staging TTL 10 分钟，启动与每次 commit 时清理。
- 失败返回：

| code | HTTP | 客户端行为 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | 回登录 |
| `FORBIDDEN` | 403 | 提示无权限 |
| `CONFLICT_REVISION` | 409 | 暂停保存，选择重载/另存/放弃 pending |
| `LEASE_HELD` / `LEASE_LOST` | 409 | 接管或转只读 |
| `LIMIT_EXCEEDED` | 413 | 提示存档过大 |
| `RATE_LIMITED` | 429 | 退避 |
| `STAGING_EXPIRED` | 409 | 重新 stage |

---

## 7. 区块编码与懒加载

### 编码（沿用现有 RLE）

```
ChunkBlob := u32 blockPairs | u16 blockData[blockPairs*2]
             u32 metaPairs  | u16 metaData[metaPairs*2]
```

- HTTP 层 base64 + gzip；服务端校验解码长度必须为 `2*65536` u16。
- 单区块 blob ≤ 1MB；单批 ≤64 区块。

### 懒加载流程

1. 进入世界：`GET /api/worlds/:id` → 获取 meta/revision/player_state
2. 预取：按出生点计算 `(2R+1)²` 个 key → `POST /chunks/query`
3. 客户端对 `missing` 生成区块；对 `found` 直接反序列化
4. 生成/加载完成后进入 `play`
5. 游戏过程中 `World` 缺区块 → 收集 key → 每 250ms 或每帧最多 1 批查询
6. 若网络失败：重试；期间该区块显示为“加载中”（不生成、不渲染）
7. 保存时只上传 `modified` 区块；服务端已有区块不受影响

**验收**：5000 区块的世界，进入 3 秒内可操作；内存中只保留视野内区块 + 少量缓存。

---

## 8. 数据模型（SQLite）

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE schema_meta (version INTEGER NOT NULL);

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash     TEXT,                        -- guest 为 NULL
  role          TEXT NOT NULL DEFAULT 'player', -- player|admin|guest
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE characters (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL COLLATE NOCASE,
  model       TEXT NOT NULL DEFAULT 'steve',  -- 目前仅 steve
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE UNIQUE INDEX idx_characters_name ON characters(name) WHERE deleted_at IS NULL;

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,             -- sha256(token)
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE worlds (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  seed            TEXT NOT NULL,
  mode            TEXT NOT NULL,
  flat            INTEGER NOT NULL DEFAULT 0,
  owner_account   TEXT NOT NULL REFERENCES accounts(id),
  owner_character TEXT REFERENCES characters(id),
  time            INTEGER NOT NULL DEFAULT 1000,
  weather         REAL NOT NULL DEFAULT 0,
  rain_target     REAL NOT NULL DEFAULT 0,
  meta_json       TEXT NOT NULL DEFAULT '{}',
  revision        INTEGER NOT NULL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'private',  -- private|lan
  generator_version INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);

CREATE TABLE world_members (
  world_id     TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  permission   TEXT NOT NULL DEFAULT 'player',
  PRIMARY KEY (world_id, character_id)
);

CREATE TABLE player_state (
  world_id     TEXT NOT NULL,
  character_id TEXT NOT NULL,
  data_json    TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (world_id, character_id)
);

CREATE TABLE chunks (
  world_id   TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  cx         INTEGER NOT NULL,
  cz         INTEGER NOT NULL,
  data       BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, cx, cz)
);

CREATE TABLE save_staging (
  world_id  TEXT NOT NULL,
  save_id   TEXT NOT NULL,
  cx        INTEGER NOT NULL,
  cz        INTEGER NOT NULL,
  data      BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (world_id, save_id, cx, cz)
);
CREATE INDEX idx_staging_age ON save_staging(created_at);

CREATE TABLE leases (
  world_id     TEXT NOT NULL,
  character_id TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (world_id, character_id)
);

CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL, account_id TEXT, action TEXT NOT NULL,
  world_id TEXT, detail TEXT
);
CREATE INDEX idx_audit_at ON audit(at);
```

**版本语义**

- **只有 `worlds.revision` 一个保存版本**；`player_state` 只有 `updated_at`。
- `generator_version` 用于 P1 生成器一致性校验。
- 所有 JSON 字段有大小上限：`meta_json` ≤ 1MB，`player_state` ≤ 256KB，`blockEntities` ≤ 4096 项。

---

## 9. 认证与权限

- 密码：`scrypt(N=16384, r=8, p=1, keylen=32)` + 随机 16B 盐；并发哈希信号量上限 **2**，其余排队。
- 会话：32B 随机 token，Cookie `mcjs_session`（HttpOnly、SameSite=Lax、Path=/；HTTPS 加 Secure），DB 只存 `sha256`。
- 有效期 30 天，滑动续期（每天一次）；登录成功重新生成 token。
- CSRF：状态变更请求必须带 `X-MCJS: 1` 且 `Origin` 与 Host 一致。
- 限速：登录 5 次/5 分钟（IP+用户名）；全局 120 请求/分钟/IP；注册 3 次/小时/IP。
- 角色名：2–16 字符，去首尾空白，禁止控制字符，全局唯一；每账号最多 5 个角色。
- 游客：**默认关闭**；`config.guest = true` 时开放，账号 24 小时无活动清理。
- 权限：`admin`（管理/踢人/`/gamemode`，P2）、`player`、`guest`。
- 审计：注册、登录失败、世界删除、导入、租约接管写 `audit`；保留 30 天。

**威胁模型**：默认仅可信家庭 LAN；HTTP 明文，公网必须置于 HTTPS 反向代理之后。

---

## 10. 角色与登录流程

```
标题
 ├─ 单人游戏（本地 IndexedDB，离线可用）
 └─ 多人游戏（?net=0 可强制离线）
     → /api/health（版本/功能检查）
     → 登录 / 注册（游客入口由服务器配置决定）
     → 角色选择（无角色则创建：名字；模型暂固定 steve）
     → 世界列表（新建 private 世界 / 导入本机 / 进入 / 删除 / 改名 / 共享）
     → 获取租约 → 预取区块 → 进入
```

- 刷新后 `GET /api/me` 自动恢复登录态。
- 登录/密码框使用 `ui.showInput`（扩展 `type=password`），触屏在用户手势内同步 focus。
- 世界列表合并本机世界，标记 `本机 / 云端` 与同步状态。

---

## 11. 存档、租约与冲突

### 进入

1. `POST /lease`（`takeover=false`）→ `{token, expiresAt}`；被占用则提示“接管/取消”
2. `GET /worlds/:id` + 预取区块
3. 每 15 秒 `lease/heartbeat`；离开时 `release`

### 自动保存（45 秒 / 退出 / 切后台）

1. `Snapshots`：`modified` + `dirtySaved` 区块，meta、player
2. 写入 `pending`（IndexedDB，按世界覆盖旧快照）
3. `stage` 分片（每批 ≤64）
4. `commit`（带 baseRevision + lease）
5. 成功：清 dirty/pending，更新 revision
6. 失败：按错误类型处理（重试/409/401）

### 冲突与接管

- 新端接管：`takeover=true` 且同账号 → 旧 token 失效；旧端下次心跳收到 `LEASE_LOST` → 转只读并提示
- `revision` 不匹配：**永不覆盖**；弹窗三选一：
  1. 放弃本地 pending，重载云端
  2. 另存为新世界（把 pending 上传为独立世界）
  3. 保持离线，稍后处理
- 租约过期 60 秒；过期后保存直接 409

### 退出

- `flush()`（等待 pending 落盘）→ `lease/release` → 关闭页面
- `beforeunload` 只做提示，不阻塞异步保存；pending 下次启动重试

---

## 12. 本机存档迁移

1. 登录后 `listWorlds` 合并本地世界（`origin=local`）
2. 点击「导入到服务器」：`POST /worlds` 建世界 → 分批 `stage` → `commit(baseRevision=0)`
3. 每批 ≤16 区块；断点续传（staging 幂等）
4. 成功后本地世界标记 `imported` 并保留只读
5. 名称冲突自动加后缀；失败可重试

---

## 13. 离线与失败处理

| 场景 | 行为 |
|---|---|
| 服务器不可达 | 标题显示离线；仅本地世界可用 |
| 登录过期 | 提示重新登录；游戏内状态保留 30 秒 |
| 保存失败 | pending 落盘 + 指数退避（1/2/5/15/60s） |
| pending 超过 32MB | 停止自动保存，提示“请保持页面打开并检查网络” |
| 网络恢复 | 自动重试；成功后刷新 revision |
| 服务端重启 | 会话与租约过期后重新获取；staging 自动清理 |
| 存档损坏 | 拒绝加载，保留原数据，提示从备份恢复 |
| 客户端版本过旧 | `/health.apiVersion` 不匹配则提示刷新 |

---

## 14. 测试与门禁

### 自动化

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元 | `node:test` | scrypt/会话、限速、区块编解码、名字校验、revision、staging 清理 |
| 集成 | 临时端口 + 内存 DB | 注册→登录→角色→世界→stage→commit→重启→读取 |
| 崩溃 | 子进程 kill | stage 中途/commit 中途 kill → 重启无半写 |
| 客户端 | Mock fetch + 内存 IDB | 懒加载、pending 合并、409/401、版本检查 |
| 安全 | 同左 | 未登录、IDOR、CSRF、超大 body、非法坐标、抢租约 |
| E2E（可选） | Playwright | 登录→角色→进入→挖方块→刷新→仍在 |
| 性能 | 脚本 | 预取 25 区块 <1s；5000 区块世界进入 <3s；stage 64 区块 <300ms |

### 门禁（每个任务）

```
□ node --check / 契约 conformance
□ server 测试全绿
□ 单机离线回归（file:// 与 localhost）
□ 重启恢复 + 崩溃无半写
□ 越权/超限/未登录均被拒绝
□ 日志无密码/token
```

---

## 15. 性能与限额

| 项 | 预算 |
|---|---|
| 预取（25 区块） | < 1s LAN |
| 进入 5000 区块世界 | < 3s |
| stage（64 区块） | < 300ms |
| commit | < 100ms |
| 单请求体 | ≤ 4MB |
| 单批区块 | ≤ 64（stage）/ 128（query） |
| staging TTL | 10 分钟 |
| pending 单世界 | ≤ 32MB |
| meta_json / player_state | ≤ 1MB / 256KB |
| 会话 / 租约 | 30 天 / 60 秒 |

---

## 16. 安全清单

- [ ] `/api`（除 health/login/register）要求会话
- [ ] 世界/角色/区块操作校验归属（防 IDOR）
- [ ] Cookie HttpOnly + SameSite；HTTPS 下 Secure
- [ ] CSRF 头 + Origin 校验
- [ ] scrypt + 随机盐 + 恒定时间比较 + 并发信号量
- [ ] 登录/注册/全局限速
- [ ] body、区块数、坐标、名字、meta 大小校验
- [ ] 错误信息不泄露内部细节
- [ ] 日志不记录密码/token
- [ ] 世界默认 private；共享需显式操作
- [ ] 备份文件仅本机用户可读

---

## 17. 任务拆解

| ID | 任务 | 关键产出 | 验收 |
|---|---|---|---|
| T0 | 服务骨架 | `server/index.js`、静态、health、启动脚本 | 8765 可访问；health 返回版本 |
| T1 | DB + 迁移 + 编解码 | `db.js`、`chunk-codec.js`、`001.sql` | 往返一致、迁移/回滚测试 |
| T2 | 认证 | 注册/登录/登出/me、scrypt 信号量、会话、CSRF、限速 | 安全用例全绿 |
| T3 | 角色 | CRUD、唯一名、数量上限 | 重名/越权/长度测试 |
| T4a | 世界 CRUD | 创建/改名/visibility/软删除、成员 | 归属与可见性测试 |
| T4b | 懒加载区块 | `chunks/query`、常量排序、预取 | 5000 区块 3s 内可玩 |
| T4c | staging 保存 | `stage/abort`、TTL 清理 | 分片/幂等/过期测试 |
| T4d | commit + 租约 | 事务、revision、lease 接管 | 崩溃无半写、抢租约测试 |
| T5a | 客户端 API | `net/api.js`、错误码、版本检查 | 契约 conformance |
| T5b | pending 队列 | `net/pending.js`、合并/限额/退避 | 断网重载后自动重试 |
| T5c | 冲突 UI | 409/LEASE_LOST 对话框 | 双标签页场景 |
| T6a | 登录/注册 UI | 新界面、密码框 | 触屏键盘可用 |
| T6b | 角色 UI | 选择/创建 | 名字校验与错误提示 |
| T6c | 世界列表 | 云端/本机合并、导入、同步状态 | 迁移大世界 |
| T7 | 懒加载接入 | `game.js/world.js` 异步区块路径 | 无建筑被覆盖 |
| T8 | 崩溃/安全/E2E | kill 测试、IDOR、CSRF、E2E | 全部通过 |
| T9 | 备份/运维/文档 | 备份恢复、优雅退出、README、契约冻结 | 演练恢复成功 |

**每个任务规则**：改动 ≤6 文件；先写测试；先冻结契约片段；提交信息含验收命令。

---

## 18. P1/P2 预留接口与待定语义

```ts
// 协议信封（v1）
type Envelope = { v:1; t:string; seq?:number; ack?:number; d?:unknown };

interface NetClient {
  connect(token: string): Promise<void>;
  join(worldId: string, characterId: string): Promise<JoinInfo>;
  sendInput(input: InputFrame): void;
  onSnapshot(cb: (s: Snapshot) => void): void;
  wantChunks(cx:number, cz:number, r:number): void;
}

interface Room {
  tick(now: number): void;
  applyInput(characterId: string, input: InputFrame): void;
  snapshot(): Snapshot;
  join(characterId: string): JoinInfo;
  leave(characterId: string): void;
}
```

**P1 必须先定的玩法语义**（进入 P1 设计前逐项确认）：

- 多人不能暂停；菜单打开世界继续
- 睡觉：全员/多数投票
- 死亡/重生：独立倒计时、背包规则
- 玩家碰撞、名字牌、皮肤
- 聊天限速与触屏聊天恢复
- 权限：`/gamemode`、建/删世界、踢人/封禁
- 同角色顶号、断线宽限（30 秒）、重连
- 实体 ID 分配与快照压缩
- 反破坏：至少记录方块操作者

**生成器一致性门禁**：P1 前用同种子抽样 200 区块，客户端与 `shared/gen/v1` 的 chunk hash 必须完全一致；已存区块永远优先。

---

## 19. 风险与回滚

| 风险 | 对策 |
|---|---|
| P0 影响单机 | Store 默认 local；`?net=0`；单机回归清单 |
| 懒加载覆盖建筑 | 只有明确 `missing` 才生成；网络错误只重试 |
| staging 膨胀 | TTL 10 分钟 + 启动清理 + 单世界 staging 上限 |
| 多标签页覆盖 | 租约 + revision；409 永不覆盖 |
| 服务器未启动 | 自动降级离线单人 |
| iPad 配额 | pending 合并 + 32MB 上限 + 提示 |
| HTTP 明文 | 明确 LAN 威胁模型；公网必须 HTTPS |
| Node sqlite 实验性 | 封装 `db.js`，可替换 better-sqlite3 |
| AI 回归 | 小步提交 + 契约测试 + 每阶段 AOCI 维护 |

---

## 20. 已确认与待确认

**已确认**

1. P0 实现懒加载区块
2. 保存使用 staging 两阶段
3. 世界默认 `private`
4. 游客默认关闭（配置开启）

**建议默认（待 P1 设计确认）**

| # | 决策 | 建议 |
|---|---|---|
| 1 | 同时在线人数 | 8 |
| 2 | 背包范围 | 每世界独立 |
| 3 | 离线单人 | 保留 |
| 4 | 角色名唯一范围 | 全服唯一 |
| 5 | P1 恢复触屏聊天 | 必须 |
| 6 | 依赖策略 | 零第三方 |

---

## 21. 下一步

1. 冻结 `docs/contracts/api-v1.json` 与 DDL（改动走 ADR）
2. 按 T0→T9 实施 P0；每 2–3 个任务提交一次
3. P0 验收后进入 P0.5（共享核心 + headless 回放 + 生成器 hash 门禁）
4. 再进入 P1 设计与实现
