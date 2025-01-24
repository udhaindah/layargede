import fs from "fs/promises";
import axios from "axios";
import readline from "readline";
import { getBanner } from "./config/banner.js";
import { colors } from "./config/colors.js";

// 配置参数
const CONFIG = {
  PING_INTERVAL: 0.5, // 心跳间隔时间（分钟）
  get PING_INTERVAL_MS() {
    return this.PING_INTERVAL * 60 * 1000; // 转换为毫秒
  },
};

// 设置终端输入模式
readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);

class WalletDashboard {
  constructor() {
    this.wallets = []; // 钱包地址列表
    this.selectedIndex = 0; // 当前选中的钱包索引
    this.currentPage = 0; // 当前页码
    this.walletsPerPage = 5; // 每页显示钱包数量
    this.isRunning = true; // 程序运行状态
    this.pingIntervals = new Map(); // 心跳定时器
    this.walletStats = new Map(); // 钱包状态信息
    this.renderTimeout = null; // 渲染定时器
    this.lastRender = 0; // 上次渲染时间
    this.minRenderInterval = 100; // 最小渲染间隔
  }

  // 初始化钱包数据
  async initialize() {
    try {
      const data = await fs.readFile("data.txt", "utf8");
      this.wallets = data.split("\n").filter((line) => line.trim() !== "");
      for (let wallet of this.wallets) {
        this.walletStats.set(wallet, {
          status: "启动中",
          lastPing: "-",
          points: 0,
          error: null,
        });

        this.startPing(wallet);
      }
    } catch (error) {
      console.error(
        `${colors.error}读取data.txt文件错误: ${error}${colors.reset}`
      );
      process.exit(1);
    }
  }

  // 获取API实例
  getApi() {
    return axios.create({
      baseURL: "https://dashboard.layeredge.io/api",
      headers: {
        Accept: "*/*",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.9",
        "Content-Type": "application/json",
        Origin: "https://dashboard.layeredge.io",
        Referer: "https://dashboard.layeredge.io/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
  }

  // 检查钱包积分
  async checkPoints(wallet) {
    try {
      const response = await this.getApi().get(`/node-points?wallet=${wallet}`);
      return response.data;
    } catch (error) {
      throw new Error(`检查积分失败: ${error.message}`);
    }
  }

  // 更新钱包积分
  async updatePoints(wallet) {
    try {
      const response = await this.getApi().post("/node-points", {
        walletAddress: wallet,
        lastStartTime: Date.now(),
      });
      return response.data;
    } catch (error) {
      if (error.response) {
        switch (error.response.status) {
          case 500:
            throw new Error("服务器内部错误");
          case 504:
            throw new Error("网关超时");
          default:
            throw new Error(`更新积分失败: ${error.message}`);
        }
      }
      throw new Error(`更新积分失败: ${error.message}`);
    }
  }

  // 领取积分
  async claimPoints(wallet) {
    try {
      const response = await this.getApi().post("/claim-points", {
        walletAddress: wallet,
      });
      return response.data;
    } catch (error) {
      throw new Error(`领取积分失败: ${error.message}`);
    }
  }

  // 启动心跳检测
  async startPing(wallet) {
    if (this.pingIntervals.has(wallet)) {
      return;
    }

    try {
      await this.claimPoints(wallet);
      this.walletStats.get(wallet).status = "已领取";
    } catch (error) {
      this.walletStats.get(wallet).status = "领取失败";
    }

    try {
      const result = await this.updatePoints(wallet);
      const stats = this.walletStats.get(wallet);
      stats.lastPing = new Date().toLocaleTimeString();
      stats.points = result.nodePoints || stats.points;
      stats.status = "运行中";
      stats.error = null;
    } catch (error) {
      const stats = this.walletStats.get(wallet);
      stats.status = "错误";
      stats.error = error.message;
    }

    const pingInterval = setInterval(async () => {
      try {
        const result = await this.updatePoints(wallet);
        const stats = this.walletStats.get(wallet);
        stats.lastPing = new Date().toLocaleTimeString();
        stats.points = result.nodePoints || stats.points;
        stats.status = "运行中";
        stats.error = null;
      } catch (error) {
        const stats = this.walletStats.get(wallet);
        stats.status = "错误";
        stats.error = error.message;
      }
      this.renderDashboard();
    }, CONFIG.PING_INTERVAL_MS);

    this.pingIntervals.set(wallet, pingInterval);
    this.renderDashboard();
  }

  // 渲染仪表盘
  renderDashboard() {
    const now = Date.now();
    if (now - this.lastRender < this.minRenderInterval) {
      if (this.renderTimeout) {
        clearTimeout(this.renderTimeout);
      }
      this.renderTimeout = setTimeout(() => {
        this.actualRender();
      }, this.minRenderInterval);
      return;
    }

    this.actualRender();
  }

  // 实际渲染逻辑
  actualRender() {
    this.lastRender = Date.now();
    let output = [];

    output.push("\x1b[2J\x1b[H");

    output.push(getBanner());

    const startIndex = this.currentPage * this.walletsPerPage;
    const endIndex = Math.min(
      startIndex + this.walletsPerPage,
      this.wallets.length
    );
    const totalPages = Math.ceil(this.wallets.length / this.walletsPerPage);

    for (let i = startIndex; i < endIndex; i++) {
      const wallet = this.wallets[i];
      const stats = this.walletStats.get(wallet);
      const prefix =
        i === this.selectedIndex ? `${colors.cyan}→${colors.reset} ` : "  ";
      const shortWallet = `${wallet.substr(0, 6)}...${wallet.substr(-4)}`;

      output.push(
        `${prefix}钱包地址: ${colors.accountName}${shortWallet}${colors.reset}`
      );
      output.push(
        `   状态: ${this.getStatusColor(stats.status)}${stats.status}${
          colors.reset
        }`
      );
      output.push(`   积分: ${colors.info}${stats.points}${colors.reset}`);
      output.push(
        `   最后心跳: ${colors.info}${stats.lastPing}${colors.reset}`
      );
      if (stats.error) {
        output.push(`   错误: ${colors.error}${stats.error}${colors.reset}`);
      }
      output.push("");
    }

    output.push(
      `\n${colors.menuBorder}第 ${this.currentPage + 1}/${totalPages} 页${
        colors.reset
      }`
    );
    output.push(`\n${colors.menuTitle}配置信息:${colors.reset}`);
    output.push(
      `${colors.menuOption}心跳间隔: ${CONFIG.PING_INTERVAL} 分钟${colors.reset}`
    );
    output.push(`\n${colors.menuTitle}操作说明:${colors.reset}`);
    output.push(
      `${colors.menuOption}↑/↓: 导航 | ←/→: 翻页 | Ctrl+C: 退出${colors.reset}\n`
    );

    process.stdout.write(output.join("\n"));
  }

  // 获取状态颜色
  getStatusColor(status) {
    switch (status) {
      case "运行中":
        return colors.success;
      case "错误":
        return colors.error;
      case "已领取":
        return colors.taskComplete;
      case "领取失败":
        return colors.taskFailed;
      case "启动中":
        return colors.taskInProgress;
      default:
        return colors.reset;
    }
  }

  // 处理键盘输入
  handleKeyPress(str, key) {
    const startIndex = this.currentPage * this.walletsPerPage;
    const endIndex = Math.min(
      startIndex + this.walletsPerPage,
      this.wallets.length
    );
    const totalPages = Math.ceil(this.wallets.length / this.walletsPerPage);

    if (key.name === "up" && this.selectedIndex > startIndex) {
      this.selectedIndex--;
      this.renderDashboard();
    } else if (key.name === "down" && this.selectedIndex < endIndex - 1) {
      this.selectedIndex++;
      this.renderDashboard();
    } else if (key.name === "left" && this.currentPage > 0) {
      this.currentPage--;
      this.selectedIndex = this.currentPage * this.walletsPerPage;
      this.renderDashboard();
    } else if (key.name === "right" && this.currentPage < totalPages - 1) {
      this.currentPage++;
      this.selectedIndex = this.currentPage * this.walletsPerPage;
      this.renderDashboard();
    }
  }

  // 启动仪表盘
  async start() {
    process.on("SIGINT", function () {
      console.log(`\n${colors.info}正在关闭...${colors.reset}`);
      process.exit();
    });

    process.on("exit", () => {
      for (let [wallet, interval] of this.pingIntervals) {
        clearInterval(interval);
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
    });

    await this.initialize();
    this.renderDashboard();

    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") {
        process.emit("SIGINT");
      } else {
        this.handleKeyPress(str, key);
      }
    });
  }
}

const dashboard = new WalletDashboard();
dashboard.start().catch((error) => {
  console.error(`${colors.error}致命错误: ${error}${colors.reset}`);
  process.exit(1);
});
