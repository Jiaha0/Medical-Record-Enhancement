# 首程助手

帮医生写首次病程记录的小工具，调用**通义千问（Qwen）**完成三件事：

| 功能 | 输入 | 输出 |
|---|---|---|
| **病史生成** | 零散要点，如"高血压10年 最高180/110 氨氯地平5mg 一天一次；2001年剖宫产" | 分段、连贯、规范的病史（主诉/现病史/既往史/个人史/婚育史/月经史/家族史） |
| **病历特点** | 一大段完整病史 | 分条要点：中年女性，44岁；慢性病程；既往高血压、剖宫产；查体……；辅助检查…… |
| **鉴别诊断** | 初步诊断 + 病史 | 每个鉴别病的典型特点、本患者支持点/不支持点、结论，以及建议完善的检查 |

- 电脑和手机共用一个网址：电脑上左右分栏，手机上上下布局、底部标签栏。
- 结果可以一键"复制"（复制的是纯文本，能直接粘贴到 HIS 病历系统），也可以一键带到下一步（病史 → 病历特点 → 鉴别诊断）。
- 服务器**不保存**任何输入或输出；输入内容只保存在医生自己浏览器的本地存储里。

---

## 一、部署到阿里云服务器（Ubuntu 26.04，2 核 2G）

整个过程大约 10 分钟。

### 0. 部署前要知道的

- **ICP 备案**：服务器在中国大陆，域名必须先完成 ICP 备案（阿里云控制台 → ICP 备案），否则用域名访问 80/443 端口会被阿里云拦截。**备案期间可以先用 `http://公网IP` 测试使用。**
- **API Key**：到 [阿里云百炼控制台](https://bailian.console.aliyun.com/) → 右上角头像 → API-KEY → 创建，得到 `sk-` 开头的 Key。新账号一般有免费额度。

### 1. 开放端口（阿里云控制台）

云服务器 ECS → 实例 → 安全组 → 配置规则 → 入方向，确保放行：**22（SSH）、80（HTTP）、443（HTTPS）**，授权对象 `0.0.0.0/0`。

### 2. 域名解析（有域名时）

在域名控制台添加 **A 记录**：主机记录 `@` 或 `www`（或你想要的子域名，比如 `bl`），记录值填服务器公网 IP。

### 3. 上传代码

在**你自己的电脑**上，把整个 `shoucheng-assistant` 文件夹传到服务器（把 `1.2.3.4` 换成你的公网 IP）：

```bash
scp -r shoucheng-assistant root@1.2.3.4:/root/
```

（Windows 可以用 PowerShell 执行同样的命令，或者用 WinSCP、FinalShell 等工具拖拽上传。）

### 4. 一键安装

SSH 登录服务器：

```bash
ssh root@1.2.3.4
```

然后运行（三选一）：

```bash
# 还没备案 / 没有域名：先用 IP 访问
cd /root/shoucheng-assistant && sudo bash deploy/setup.sh
```

```bash
# 已备案并解析好域名：自动申请免费 HTTPS 证书
cd /root/shoucheng-assistant && sudo bash deploy/setup.sh your-domain.com
```

```bash
# 同上，并让证书提醒发到你的邮箱
cd /root/shoucheng-assistant && sudo bash deploy/setup.sh your-domain.com you@example.com
```

脚本会自动：加 1G swap → 安装 Nginx、Certbot、Node.js → 把代码放到 `/opt/shoucheng` → 安装依赖（用国内 npm 镜像）→ 注册开机自启服务 → 配置 Nginx → 申请 HTTPS 证书（证书会自动续期）。

### 5. 填写 API Key

```bash
sudo nano /opt/shoucheng/.env
```

把 `DASHSCOPE_API_KEY=` 后面填上你的 Key，按 `Ctrl+O` 回车保存，`Ctrl+X` 退出，然后重启服务：

```bash
sudo systemctl restart shoucheng
```

打开网址，左上角显示 `qwen-max` 就说明已经连上模型了（没填 Key 时显示"演示模式"，只会输出固定示例）。

### 6. 以后更新

把新代码重新上传到 `/root/shoucheng-assistant`，再运行一次同样的 `setup.sh` 命令即可（不会覆盖 `.env`）。只改了 prompt 的话，直接改 `/opt/shoucheng/prompts/*.md`，然后重启服务：

```bash
sudo systemctl restart shoucheng
```

---

## 二、常用运维命令

| 用途 | 命令 |
|---|---|
| 查看运行状态 | `systemctl status shoucheng` |
| 查看日志（只记录错误，不含病历内容） | `journalctl -u shoucheng -n 100 -f` |
| 重启 | `sudo systemctl restart shoucheng` |
| 检查 Nginx 配置 | `sudo nginx -t` |
| 手动续期证书测试 | `sudo certbot renew --dry-run` |

## 三、配置项（`/opt/shoucheng/.env`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 空 | 百炼 API Key，为空时进入演示模式 |
| `QWEN_MODEL` | `qwen-max` | 实测 `qwen-max` 最守规矩（不编造、不串条目）；想省钱可改为 `qwen-plus`，或百炼控制台里的其他模型名 |
| `RATE_LIMIT_PER_MIN` | `10` | 每个 IP 每分钟最多生成次数，防止网址被人用脚本刷、耗光额度；`0` 为不限制 |
| `MAX_INPUT_CHARS` | `8000` | 单次输入字数上限 |
| `MOCK` | `0` | 设为 `1` 时不调用模型，只输出示例（调试界面用） |

## 四、调整 Prompt（约束模型输出）

所有约束都在 `prompts/` 目录下的 Markdown 文件里，直接用中文写，不需要懂代码：

- `common.md`：三个功能共用的规则（不编造、保留原始数值和药名、只输出正文……）
- `history.md`：病史的段落结构、缺失信息的写法、示例
- `features.md`：病历特点的条目顺序、年龄段和病程的划分标准、示例
- `differential.md`：鉴别诊断的格式、结论只能三选一、示例

改完后重启服务生效。建议改动后用页面上的"填入示例"按钮跑一遍对比效果。想让输出更贴近你们科室的写法，最有效的办法是把 `示例` 部分换成你们科室真实（脱敏后）的病历。

## 五、本地开发

```bash
npm install
npm run mock     # 不需要 Key，用模拟输出调界面，打开 http://127.0.0.1:3000
```

```bash
DASHSCOPE_API_KEY=sk-xxx npm start   # 调用真实模型
```

## 六、注意事项

- 本工具输出仅供参考，**必须由执业医师审核**后才能写入病历。
- 网址没有登录限制，任何知道网址的人都能使用并消耗你的 API 额度。建议在百炼控制台设置**额度告警**；如果发现被滥用，可以调小 `RATE_LIMIT_PER_MIN`。
- 输入的内容会发送到阿里云百炼进行处理。建议医生输入时去掉姓名、身份证号、住院号等身份信息。
