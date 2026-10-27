# 浏览器 HTTPS 测试夹具

`localhost.pem`、`localhost-rotated.pem` 和 `localhost.key` 是本仓库专用的合成自签名证书及公开测试私钥，不用于任何真实服务。第二张证书使用不同序列号，用于验证同一站点更换证书后需要重新确认。

`test/browser-profile-smoke.cjs` 和 `test/browser-connection-smoke.cjs` 仅访问隔离 Electron 进程中的回环 HTTPS 服务，通过生产浏览器的证书确认入口验证临时信任。测试先检查证书指纹，不安装系统证书，也不全局关闭校验。

运行 `electron test/browser-connection-smoke.cjs` 后，再运行 `electron test/browser-connection-smoke.cjs --restart-check`，可验证同一测试 profile、同一来源在应用重启后恢复证书验证。测试报告位于 `.codex-tmp/browser-connection-smoke/`。

这些测试文件不包含在应用打包清单中。
