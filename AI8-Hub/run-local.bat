@echo off
setlocal
chcp 65001 >nul

cd /d "%~dp0"

echo [AI8] 正在检查 Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo [AI8] 未检测到 Node.js，请先安装 Node.js 18+。
    pause
    exit /b 1
)

if not exist ".env" (
    echo [AI8] 未找到 .env，正在从 .env.example 复制一份...
    copy /y ".env.example" ".env" >nul
)

if not exist "node_modules" (
    echo [AI8] 首次启动，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [AI8] npm install 失败，请检查网络或 npm 配置。
        pause
        exit /b 1
    )
)

echo [AI8] 3 秒后自动打开后台页面...
start "" "http://127.0.0.1:7862/admin"
timeout /t 3 /nobreak >nul

echo [AI8] 正在启动服务...
call npm start

endlocal
