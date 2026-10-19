# cloud-v0.0.45

本版主题：**反馈与官网入口换到更快的域名。**

## 版本号说明

本版号从 cloud-v0.0.41 直接到 **cloud-v0.0.45**（0.0.42/0.0.43 的 tag 未产出 Release 的部分与本版合并；以本版为最新）。

## 改了什么

反馈页与官网地址从 `www.jvszzp.ltd` 迁到 **`dl.ppz123.asia`**：

- `.github/ISSUE_TEMPLATE/` 三个模板 + `config.yml` 官网地址
- 更新检查的 base 常量
- 账号菜单「问题反馈」的跳转地址
- `README.md` 的官网反馈页入口

### 为什么换

`jvszzp.ltd` 走 **Cloudflare Tunnel**（实测首字节 3.15s / 总计 5.25s），且源站用 **Cloudflare Origin Certificate** —— 改成灰云直连会被浏览器判「证书不受信任」，这就是它「关掉就访问不了」的根因。

`dl.ppz123.asia` 是 A 记录直连 `124.220.63.4` + Let's Encrypt 证书，实测 **0.21~0.49s**。

## mac 首次打开

```bash
xattr -cr "/Applications/Codex Assistant.app"
```

⚠️ 自 cloud-v0.0.42 起云助手的 `productName` 已独立为 `Codex Assistant`（不再与标准版同名），
旧版遗留的 `Codex Harness Desktop` 快捷方式需要手动清理。

## 已知问题

- `www.jvszzp.ltd` 仍可用但慢，旧书签不会自动更新。
- 历史发版说明里的旧域名保留原文。
