# 🚀 AetherPanel & AetherNode
### Next-Generation Game Panel Control Plane

AetherPanel is a high-performance, full-stack game server management panel built with **React 19**, **TypeScript**, **Tailwind CSS**, and a robust **Express backend engine**. It is designed for high-concurrency environments, offering seamless server orchestration, real-time telemetry, and enterprise-grade security.

---

## 💻 Local Development Setup

Follow these steps to deploy a development instance of AetherPanel on your local machine.

### 1. Prerequisites
Ensure your environment meets the following minimum requirements:
* **Node.js**: v18.0.0+ (v20+ Recommended)
* **npm**: v9.0.0+
* **Git**: System-level installation

### 2. Installation
```bash
curl -fsSL https://github.com/adityazdomainzz-code/Aetherpanel/raw/main/install.sh -o install.sh
sudo bash install.sh --panel --admin-email tera@email.com --admin-password 'MazbootPassword123'

 #status 
 systemctl status aetherpanel --no-pager | head -5
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/

# for vps 
apt install -y lxcfs && systemctl enable --now lxcfs      # Docker VPS mein sahi RAM dikhe
apt install -y incus && incus admin init --minimal        # Ubuntu 24.04 / Debian 12
```

### 3. update panel 
```bash
sudo bash /opt/aetherpanel/update.sh
```
The control plane will boot on **port 3000** by default.

### 4. Access
Open your browser and navigate to:
👉 **`http://localhost:3000`**

---

## 🔑 Administrative Access

Use the following default credentials for your initial login. **You will be required to update these credentials upon first successful authentication.**

* **Email**: `admin@aetherpanel.in`
* **Password**: `adminopp`

---

## 🛠️ Toolchain & Scripts

| Command | Function |
| :--- | :--- |
| `npm run dev` | Boots Express + Vite in hot-reload mode (Port 3000) |
| `npm run lint` | Performs static type analysis and linting |
| `npm run build` | Compiles assets and bundles server to `dist/server.cjs` |
| `npm start` | Executes the production-ready bundle |

---

---

## 🌟 Core Capabilities

* **Multi-Instance Orchestration**: Effortlessly manage Minecraft (Paper/Purpur/Vanilla/Fabric/Forge), Discord Bots (Node.js/Python), and dedicated Databases.
* **Real-Time Telemetry**: Live CPU, RAM, and Disk metrics streamed via high-speed WebSocket connections.
* **Integrated Marketplace**: Search and deploy plugins directly from Modrinth and Hangar repositories.
* **Granular RBAC**: Complex subuser permission system for collaborative server management.
* **Native SFTP & File Manager**: Full-featured web-based file management with integrated SFTP for batch operations.
* **Self-Healing Nodes**: Automated heartbeat monitoring and daemon auto-recovery.

---

## 🛡️ Security Architecture

* **Container Isolation**: Each server instance is strictly jailed within its own Docker-based container.
* **Encrypted Secrets**: All API keys and node tokens are encrypted using AES-256-GCM.
* **Secure WebSockets**: Real-time data streams are protected via stateful session authentication.
* **Sandboxed Filesystem**: Strict path-traversal protection prevents unauthorized filesystem access.
