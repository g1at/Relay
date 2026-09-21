# 浏览器 HTTPS 测试夹具

`localhost.pem` 和 `localhost.key` 是本仓库专用的合成自签名证书及公开测试私钥，不用于任何真实服务。

`test/browser-profile-smoke.cjs` 仅在自身的隔离 Electron 进程中，对本次启动的回环 HTTPS 服务校验该证书的 SHA-256 指纹后信任，用于验证安全来源上的密码与联系人填充。生产浏览器不会加载此证书，也不会跳过证书校验。这些测试文件不包含在应用打包清单中。
