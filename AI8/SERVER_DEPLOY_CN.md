# AI8 适配器服务器部署说明

本文说明如何把 `AI8/` 目录部署到服务器，并通过 Web 后台管理配置。

## 一、准备条件

服务器建议满足：

- Linux 服务器，推荐 Ubuntu 22.04 或 Debian 12
- 已开放你要使用的端口，例如 `7862`
- 已安装 `Node.js 18+`
- 或者已安装 `Docker` 与 `Docker Compose`

你还需要准备：

- 一个可用的 `AI8_AUTH_TOKEN`
- 一个你自己的本地 API 密钥，例如 `API_KEYS=your-api-key`
- 一个后台令牌，例如 `ADMIN_TOKEN=your-admin-token`

## 二、目录说明

部署时主要用到这些文件：

- `server.js`
- `package.json`
- `admin/`
- `lib/`
- `.env`
- `docker-compose.yml`

运行后会产生或使用这些目录：

- `data/`
- `logs/`

## 三、方式一：直接用 Node.js 部署

### 1. 上传文件

把整个 `AI8/` 目录上传到服务器，例如：

```bash
/opt/ai8-adapter
```

### 2. 安装依赖

进入目录后执行：

```bash
cd /opt/ai8-adapter
npm install
```

### 3. 配置 `.env`

示例：

```env
PORT=7862
API_KEYS=your-local-api-key
ADMIN_TOKEN=your-admin-token

AI8_BASE_URL=https://ai8.rcouyi.com/api
AI8_AUTH_TOKEN=your-ai8-token
AI8_DEFAULT_MODEL=openai_chat::gpt-4.1-mini
AI8_DEFAULT_THINKING=false
AI8_REQUEST_TIMEOUT_MS=300000
AI8_SHARED_SESSION_ID=
MEDIA_FETCH_TIMEOUT_MS=60000
REQUEST_BODY_LIMIT=50mb

PUBLIC_BASE_URL=https://your-domain.example
AI8_CONFIG_PATH=./data/config.json
AI8_LOG_PATH=./logs/ai8-adapter.log
```

说明：

- `API_KEYS` 是你的客户端调用本地 OpenAI 兼容接口时使用的密钥
- `ADMIN_TOKEN` 是网页登录后台时使用的密钥
- `PUBLIC_BASE_URL` 建议填你的域名，后台会据此显示最终 API 地址
- `AI8_SHARED_SESSION_ID` 可选，填了以后所有请求默认复用同一个 AI8 会话

### 4. 启动服务

先测试启动：

```bash
cd /opt/ai8-adapter
npm start
```

访问：

```text
http://服务器IP:7862/admin
```

### 5. 使用 PM2 常驻运行

安装 PM2：

```bash
npm install -g pm2
```

启动：

```bash
cd /opt/ai8-adapter
pm2 start server.js --name ai8-adapter
pm2 save
pm2 startup
```

查看日志：

```bash
pm2 logs ai8-adapter
```

## 四、方式二：使用 Docker 部署

### 1. 准备 `.env`

在 `AI8/` 目录内写好 `.env`。

### 2. 启动容器

```bash
cd /opt/ai8-adapter
docker compose up -d --build
```

### 3. 查看状态

```bash
docker compose ps
docker compose logs -f
```

### 4. 停止容器

```bash
docker compose down
```

容器中的持久化目录：

- `./data` 对应 `/app/data`
- `./logs` 对应 `/app/logs`

后台修改的配置会写入 `data/config.json`，容器重启后仍然保留。

## 五、Nginx 反向代理示例

如果你要用域名访问，可以在 Nginx 中加入：

```nginx
server {
    listen 80;
    server_name your-domain.example;

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:7862;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
    }
}
```

重载 Nginx：

```bash
nginx -t
systemctl reload nginx
```

如果用了域名，建议 `.env` 同时设置：

```env
PUBLIC_BASE_URL=https://your-domain.example
```

## 六、后台使用方式

后台地址：

```text
http://你的域名或IP:7862/admin
```

登录后可以做这些事：

- 修改 AI8 授权令牌
- 修改本地 API 密钥
- 修改后台令牌
- 设置默认模型
- 设置固定复用的 AI8 会话 ID
- 查看当前模型列表
- 测试 AI8 上游连通性
- 查看运行日志

## 七、客户端调用方式

OpenAI 兼容调用地址：

```text
http://你的域名或IP:7862/v1
```

例如：

```bash
curl http://your-domain.example/v1/chat/completions \
  -H "Authorization: Bearer your-local-api-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai_chat::gpt-4.1-mini","messages":[{"role":"user","content":"你好"}]}'
```

## 八、关于 AI8 前台会话

如果你不希望每次请求都在 AI8 前台生成一个新会话，可以设置：

```env
AI8_SHARED_SESSION_ID=123456
```

这样你的 API 请求默认会复用同一个 AI8 会话。

但需要明确：

- 本地这层适配器可以做到“你的客户端只通过 API 收发”
- 是否完全不在 AI8 网站前台显示，取决于 AI8 上游本身是否会保存会话
- 如果 AI8 自己保留会话记录，这层代理无法强制让 AI8 不显示

## 九、排错建议

### 1. 后台能打开，但拉不到模型

通常是 `AI8_AUTH_TOKEN` 失效，去后台重新填写。

### 2. 图片上传失败

检查：

- `REQUEST_BODY_LIMIT` 是否太小
- 反向代理的 `client_max_body_size` 是否太小

### 3. 客户端调用 401

检查：

- 是否传了 `Authorization: Bearer your-local-api-key`
- `.env` 或后台里的 `API_KEYS` 是否正确

### 4. 后台 401

检查：

- 使用的是不是 `ADMIN_TOKEN`
- 或者使用了 `API_KEYS` 中的任意一个值

### 5. Docker 重启后配置丢失

检查 `data/` 目录是否已挂载。
