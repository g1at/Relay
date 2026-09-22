# 主进程结构

根 `main.js` 保持 Electron 启动入口稳定，实际组装位于 `bootstrap.js`。模块使用 CommonJS；界面脚本留在 `renderer/`，根目录的两个 preload 保持完整单文件，适用于沙箱窗口。

## 职责与状态归属

| 位置 | 负责内容 |
| --- | --- |
| `bootstrap.js` | 组装服务、连接 IPC 与任务执行；持有任务和在线会话状态 |
| `app/application-windows.js` | 主窗口、欢迎页、托盘、原生主题及窗口关闭行为 |
| `app/application-lifecycle.js` | ready/activate/quit 生命周期，以及退出前的持久化等待 |
| `app/app-settings-service.js` | 设置缓存、原子写入与兼容迁移 |
| `app/history-store.js` | 历史正文、索引、恢复与旧格式迁移 |
| `app/settings-ipc.js`、`app/history-ipc.js` | 设置和普通历史操作的 IPC 注册 |
| `providers/`、`memory/`、`skills/`、`scheduling/` | 对应领域服务与 IPC 注册 |
| `sdk/`、`live/`、`tasks/` | SDK 适配、输入与轮次控制、任务账本及后台执行 |
| `projects/`、`workspace/`、`browser/` | 项目目录与会话归属、文件/终端/审查、浏览器视图 |
| `usage/` | 请求用量采集与统计后台进程 |

`jobs`、`liveSessions` 和任务资源租约由组装层持有，生命周期服务通过明确的接口访问同一实例。窗口状态由窗口服务持有，其他模块通过 getter 读取最新窗口。不要复制状态容器，也不要让领域服务反向加载 `bootstrap.js`。

任务结束的 checkpoint 写锁、`job-done` 通知与后续保存顺序保持在同一个协调函数中。退出时先等待技能草稿、小窗记录、用量统计和任务进度持久化，再释放窗口、任务和子进程资源。新增模块不得在导入时启动另一套 SDK、任务调度或退出流程。

## 应用资源与后台进程

`app/paths.js` 不依赖 Electron，可以由普通 Node 和 WSL helper 使用：

- `appRoot`：当前应用代码所在的根目录。
- `resourcePath(...segments)`：相对于应用根的资源路径。
- `unpackPath(file)`：将路径中的 `app.asar` 段映射到 `app.asar.unpacked`，用于操作系统实际执行的文件。
- `unpackedPath(...segments)`：先定位应用资源，再映射到解包路径。

应用根与项目工作目录是不同概念。SDK 依赖、页面和 preload 使用应用资源路径；同目录 worker 使用模块自身目录；用户数据沿用 `app.getPath('userData')`。不要通过修改 `process.cwd()` 或用户数据位置修复资源查找。

普通 Node/WSL 无法加载 Electron 虚拟归档。后台脚本及其全部本地依赖必须列入 `package.json` 的 `asarUnpack`；仅解包 worker 入口不够。新增同级 require 时同步检查依赖是否也在真实磁盘。不要将全部源码或私人目录加入打包清单。

## 验证

移动模块后同步修改导入、运行资源、测试引用与打包规则。优先通过真实工厂注入依赖，避免测试只读取根启动薄入口。仍需源码提取的任务协调测试应读取实际 `bootstrap.js`，保留任务归属、停止、迟到事件和持久化断言。

常用验证：

```powershell
npm test
npm run test:ui
npm run test:crash-progress
npm run test:progress-asar
npm run build:dir -- --x64 --publish never
npm run test:packaged-app
```

`test:packaged-app` 检查实际 ASAR 与解包文件，运行合成数据下的 worker、沙箱 preload 和终端验证。它不替代真实模型、外部 MCP 或安装升级验收。Windows CI 使用固定的构建环境；本地原生依赖工具链应与 Electron ABI 匹配。
