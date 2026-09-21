# README 界面素材

这些图片使用 **Relay 3.0.1 当前源码的真实 renderer** 渲染，内容全部为合成演示数据。它们展示产品界面，不代表真实模型执行、真实用户项目或安装即自带的技能。

| 文件 | 内容 | 尺寸 |
| --- | --- | --- |
| [workspace-light.png](workspace-light.png) | 浅色主题下的项目对话与 Markdown 文件预览 | 1680 × 1050 |
| [workspace-dark.png](workspace-dark.png) | 同一工作区的深色主题 | 1680 × 1050 |
| [skills.png](skills.png) | 插件页面与六项演示技能 | 1680 × 1050 |
| [memory.png](memory.png) | 个性化说明、记忆与维护选项 | 1680 × 1050 |
| [quick-chat.png](quick-chat.png) | 浮动快捷对话窗口 | 800 × 780 |

Logo 直接引用应用的 `renderer/logo.svg` 与 `renderer/logo-dark.svg`。截图中的 `C:/Relay-Demo/` 是虚构路径；未包含真实账户、凭据或业务数据。

## 重新生成

在已安装依赖的 Windows 开发环境中运行：

```powershell
.\node_modules\.bin\electron.cmd build/capture-readme.cjs
```

[生成脚本](../../build/capture-readme.cjs) 加载真实界面和仓库内的内存 API fixture，不加载 Relay 主进程或 preload。它使用独立的 `.codex-tmp/readme-capture/isolated-profile/`，阻止 HTTP(S) 请求，也不访问服务商或个人配置。

输出位于 `.codex-tmp/readme-capture/`。`capture-evidence.json` 记录捕获时间、源码哈希、图片哈希、界面错误与网络拦截结果；临时页面、配置与完整证据不随素材提交。脚本验证单个文档标签、界面无横向溢出、无运行错误和网络请求，不修改生产界面或样式。

重新生成后，请目视检查上表五张图片，再按文件名替换本目录素材并更新 [manifest.json](manifest.json) 的采集信息、字节数和 SHA-256。不要复制失败截图或整个临时配置目录。

## 本次素材

采集日期：2026-09-21。五张图总计小于 650 KiB，使用 Electron `capturePage()` 直接捕获，无后期重绘。截图采用应用字体，字体本身继续适用其独立许可，见 [第三方声明](../../THIRD_PARTY_NOTICES.md)。
