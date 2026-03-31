# NL2SQL VS Code Extension

这是一个将自然语言转换为SQL查询的VS Code插件初稿。

## 功能特点

- 🔄 自然语言到SQL的转换
- 📋 右键菜单集成
- 🎛️ 专用的转换面板
- 📝 支持中文自然语言输入
- 🎨 VS Code主题适配

## 使用方法

### 方法一：选择文本转换
1. 在编辑器中选择要转换的自然语言文本
2. 右键点击选择 "Convert Natural Language to SQL"
3. 转换结果将在新的SQL文档中打开

### 方法二：使用转换面板
1. 使用 `Ctrl+Shift+P` 打开命令面板
2. 输入 "Open NL2SQL Panel" 并执行
3. 在面板中输入自然语言查询
4. 点击转换按钮获得SQL结果

## 支持的查询示例

- "查询所有用户信息" → `SELECT * FROM users;`
- "获取订单数据" → `SELECT * FROM orders;`
- "插入新用户" → `INSERT INTO table_name (column1, column2) VALUES (value1, value2);`
- "更新用户信息" → `UPDATE table_name SET column1 = value1 WHERE condition;`
- "删除过期订单" → `DELETE FROM table_name WHERE condition;`

## 开发和安装

### 前置条件
- Node.js (版本 16 或更高)
- VS Code

### 安装依赖
```bash
npm install
```

### 编译项目
```bash
npm run compile
```

### 开发模式
```bash
npm run watch
```

### 调试插件
1. 打开项目文件夹
2. 按 F5 启动调试
3. 在新的VS Code窗口中测试插件

## 项目结构

```
vscode_NL_to_SQL/
├── package.json          # 插件清单文件
├── tsconfig.json         # TypeScript配置
├── src/
│   └── extension.ts      # 主要的插件代码
└── README.md            # 说明文档
```

## 后续改进方向

1. **集成AI模型**: 接入OpenAI GPT、Google Bard或本地模型
2. **数据库架构感知**: 根据数据库表结构生成更准确的SQL
3. **多数据库支持**: 支持MySQL、PostgreSQL、SQLite等不同方言
4. **语法验证**: 添加生成SQL的语法检查
5. **历史记录**: 保存转换历史供用户查看
6. **配置选项**: 允许用户自定义转换规则和偏好

## 注意事项

- 目前的转换功能是基于简单关键词匹配的示例实现
- 实际使用中需要集成真正的NL2SQL模型或API
- 这只是一个基础框架，可以根据需求进行扩展

## 许可证

MIT