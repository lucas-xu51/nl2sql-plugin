# 📝 NL2SQL VSCode Plugin

A user-oriented VSCode plugin for generating SQL queries from natural language (NL2SQL) using DAIL-SQL with few-shot learning and Copilot models.

---

## 🚀 Main Features

The plugin interface provides the following functionalities:

1. **🗄️ Database Engine Selection**  
   Supports SQLite databases.

2. **📂 Database Selection**  
   Automatically scans the workspace for SQLite files for selection. Users can also upload their own database files.

3. **🤖 Model Selection**  
   Supports Copilot models, consistent with GitHub Copilot, enabling users to work in a familiar environment.

4. **⚡ Few-shot Configuration**  
   Users can configure the number of few-shot examples, including both history and general few-shot. This setting affects prompt token size and SQL accuracy.

5. **💬 Natural Language Query (NLQ) Input**  
   Enter your natural language queries here as input for SQL generation.

6. **📝 SQL Output**  
   Displays the generated SQL query. Users can manually edit the output for flexibility.

7. **✅ Execution Result**  
   Shows the results of executing the SQL query on the selected database to verify correctness.

8. **💾 Few-shot Caching**  
   Clicking the `Save Few-shot` button stores the current NLQ and SQL output locally for future few-shot construction.

9. **🔍 Database Details**  
   Clicking the `Database Detail` button switches to a detailed database view, including table structures and sample data, improving schema understanding.

---

## ⚙️ Installation and Setup

### Prerequisites

- Node.js (v16 or higher)  
- Visual Studio Code

### Install Dependencies

```bash
npm install

### preview

<img width="676" height="378" alt="image" src="https://github.com/user-attachments/assets/d8349514-8136-4d09-a200-1b791d75cbee" />

<img width="676" height="378" alt="image" src="https://github.com/user-attachments/assets/d796ff7b-f0c6-4e94-a366-c0c7306ffae9" />

