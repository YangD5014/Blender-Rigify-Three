# PetFison_Sensor WebSocket 接入协议

## 概述

`PetFison_Sensor` 是运行在云服务器 `124.222.169.94:2001` 的 WebSocket 服务，
用于实时下发关节（含 `torso` 躯干主控）的姿态四元数，驱动浏览器端 3D 猫咪模型。

- 协议：WebSocket (RFC 6455)
- 地址：`ws://124.222.169.94:2001/`（生产环境可按域名替换主机）
- 编码：UTF-8 JSON 文本帧
- 服务名：`PetFison_Sensor`
- 项目目录：`/www/wwwroot/PetFison_Sensor/server.py`

## 坐标系与四元数约定

- 四元数字段统一为 `{ "x", "y", "z", "w" }`（Hamilton 约定，`w` 为标量部）。
- `space` 字段指定四元数所在空间：
  - `basis`（默认）：骨骼局部空间，相对 rest 姿态的附加旋转。与 3D 页面 monitor
    中显示的 `basis q` 一致。**推荐控制时使用此空间**，因为 rest 补偿已由引擎处理。
  - `world`：世界/臂架空间（glTF Y-up 坐标系）的绝对朝向。服务端/客户端会根据父级
    rest 矩阵换算为 basis。
- 关节名即 Rigify 骨骼名，例如：`torso`、`neck`、`head`、`tail_master.001`、
  `upper_arm.L` 等。完整列表见 `data/rig.json` 的 `bones` 键。

## 连接流程

1. 客户端（3D 查看器 / 控制台 / 传感器）发起 WebSocket 连接。
2. 服务端立即推送 `welcome`，随后推送当前所有关节的 `snapshot`（若已有状态）。
3. 客户端可随时发送控制消息；服务端广播给**所有**已连接客户端（含发送方）。

## 消息：客户端 → 服务端

### 1. 设置单个关节

```json
{
  "type": "set",
  "joint": "torso",
  "quaternion": { "x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0 },
  "space": "basis",
  "position": { "x": 0.0, "y": 0.0, "z": 0.0 }   // 可选
}
```

简写字段也支持：`q` 代替 `quaternion`，`name`/`bone` 代替 `joint`，`p` 代替 `position`。

### 2. 批量设置多个关节

```json
{
  "type": "set_multi",
  "joints": {
    "torso": { "quaternion": { "x": 0, "y": 0, "z": 0, "w": 1 }, "space": "basis" },
    "neck":  { "quaternion": { "x": 0, "y": 0, "z": 0, "w": 1 }, "space": "basis" }
  }
}
```

别名：`type: "pose"` / `"batch"`。

### 3. 查询单个关节

```json
{ "type": "get", "joint": "torso" }
```

### 4. 列出所有已记录关节

```json
{ "type": "list_joints" }
```

### 5. 心跳

```json
{ "type": "ping" }
```

## 消息：服务端 → 客户端

### welcome

```json
{ "type": "welcome", "service": "PetFison_Sensor", "port": 2001 }
```

### snapshot（连接时推送全部当前状态）

```json
{
  "type": "snapshot",
  "joints": {
    "torso": { "joint": "torso", "quaternion": {...}, "space": "basis", "timestamp": 169... }
  }
}
```

### state（单关节更新广播）

```json
{ "type": "state", "joint": "torso", "quaternion": {...}, "space": "basis", "timestamp": 169... }
```

### state_multi（多关节更新广播）

```json
{ "type": "state_multi", "joints": { "torso": {...}, "neck": {...} } }
```

### joint_list

```json
{ "type": "joint_list", "joints": ["torso", "neck"] }
```

### pong

```json
{ "type": "pong", "timestamp": 169... }
```

### error

```json
{ "type": "error", "message": "..." }
```

## 典型用法：torso 实时控制

1. 3D 页面 `index_websocket.html` 连接 WebSocket，收到 `state`/`snapshot` 后，
   将 `torso` 的四元数写入引擎 `basis`，调用 `evaluateAndApply()` 重算蒙皮。
2. 控制台（`2000/PetFusion/Control`）或传感器向服务端发送 `set` 消息。
3. 服务端广播给所有查看器，实现多端同步。

## 多关节扩展

协议天然支持任意数量关节：`joint` 字段可为任意骨骼名，`set_multi` 可一次下发全身姿态。
未来新增控制关节只需使用其骨骼名，无需修改协议。

## 服务管理

```bash
# 状态
systemctl status petfison-sensor
# 重启
systemctl restart petfison-sensor
# 日志
tail -f /www/wwwlogs/PetFison_Sensor/out.log
tail -f /www/wwwlogs/PetFison_Sensor/err.log
```

## 相关页面

- 3D 查看器（WebSocket 版）：`http://124.222.169.94:2000/blender-3d-operator/index_websocket.html`
- 控制台：`http://124.222.169.94:2000/PetFusion/Control/`
