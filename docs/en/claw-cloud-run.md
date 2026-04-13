# Deploy on Claw Cloud Run

This guide will help you deploy the `canvas-to-api` service on [Claw Cloud Run](https://claw.cloud/).

## 📦 Deployment Steps

1. **Login**: Go to [https://us-west-1.run.claw.cloud](https://us-west-1.run.claw.cloud) and log in to your account.
2. **Create App**: Navigate to **App Launchpad** and click the **Create App** button in the top right corner.
3. **Configure Application**: Fill in the following parameters:
   - **Application Name**: Enter any name you prefer (e.g., `canvas-api`).
   - **Image**: Select **Public**.
   - **Image Name**: `ghcr.io/ibuhub/canvas-to-api:latest`

   **Usage**:
   - **CPU**: `0.5`
   - **Memory**: `1G`

   **Network**:
   - **Container Port**: `7861`
   - **Public Access**: enabled

   **Environment Variables**:

   You must set the `API_KEYS` variable. Other variables are optional (refer to the [Configuration](../../README_EN.md#-configuration) section in the main README).

   | Name       | Value                 | Description                                |
   | :--------- | :-------------------- | :----------------------------------------- |
   | `API_KEYS` | `your-secret-key-123` | **Required**. Define your own access keys. |

4. **Deploy**: Click **Create App** to start the deployment.

## 📡 Accessing the Service

1. Once the app is running, go to the **Network** tab in the App details page.
2. Copy the **Public Address** (URL).
3. Access the URL in your browser. You will need to enter the `API_KEYS` you configured to access the management console.

## 🔑 Account Management

The current version no longer uses VNC login or auth-file upload for account management. After deployment, follow the main README [Browser Session Connection](../../README_EN.md#-browser-session-connection) flow directly.

On the Gemini share page, fill in:

- `Browser Identifier`: any label you want to use for the browser session
- `API Key`: the same key you use for API requests
- `Server WS Endpoint`: if your console is accessed through Claw Cloud over `https://`, this should be `wss://your-public-address/ws`

Examples:

- If your console URL is `https://canvas-api-xxxx.claw.cloud`
  then `Server WS Endpoint` should be `wss://canvas-api-xxxx.claw.cloud/ws`
- If you later bind your own HTTPS domain, for example `https://api.example.com`
  then use `wss://api.example.com/ws`

After the browser session connects, return to the status page and confirm that `Browser Sessions` shows at least one online session before sending API traffic.

## 🔌 API Endpoints

After deployment, you can access the API using the **Public Address** combined with the following Base URLs:

- **OpenAI Compatible Base URL**: `https://<your-public-address>/v1`
- **OpenAI Responses Compatible Base URL**: `https://<your-public-address>/v1`
- **Gemini Compatible Base URL**: `https://<your-public-address>/v1beta`
- **Anthropic Compatible Base URL**: `https://<your-public-address>/v1`

> For more details, please refer to the [API Usage](../../README_EN.md#-api-usage) section in the main README.

## 🔄 Updating the Application

To update to the latest version, click the **Update** button in the top right corner of the App details page.
